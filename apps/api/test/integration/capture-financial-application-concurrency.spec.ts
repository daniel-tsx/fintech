import { setTimeout as delay } from 'node:timers/promises';
import type { Sql, TransactionSql } from 'postgres';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import type { ObservationTransactions } from '../../src/payment-provider/provider-observation-database';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { RefundsService } from '../../src/refunds/refunds.service';
import { WebhookBusinessService } from '../../src/webhooks/webhook-business.service';
import type { ReceiptTransactions } from '../../src/webhooks/trusted-receipt-database';
import { TrustedSignedReceiptService, type SignedReceiptResult } from '../../src/webhooks/trusted-signed-receipt.service';
import type { ProviderEvent } from '../../src/webhooks/webhook.types';
import { captureFinancialApplicationHarness } from '../support/capture-financial-application-harness';
import type { CapturePreparationRequest } from '../support/capture-preparation-harness';
import { ScriptedStripeHttp } from '../support/provider-observation-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30000);

describeDb('B2-B capture financial application concurrency', () => {
  let h: Awaited<ReturnType<typeof captureFinancialApplicationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  type Work = (tx: TransactionSql) => Promise<unknown>;
  type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
  const rollback = new Error('intentional schedule rollback');
  let currencySequence = 0;
  const coldCurrency = () => `X${String.fromCharCode(65 + Math.floor(currencySequence / 26))}${String.fromCharCode(65 + currencySequence++ % 26)}`;
  const latch = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  };
  const outcome = (promise: Promise<unknown>): Promise<Outcome> => promise.then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));
  const assertNoDeadlock = (result: Outcome) => {
    if (!result.ok) expect(result.error).not.toMatchObject({ code: '40P01' });
  };
  beforeAll(async () => { h = await captureFinancialApplicationHarness(); await h.install(); });
  afterAll(async () => { if (h) await h.close(); });

  async function waitFor(blocker: number, waiter: number) {
    expect(blocker).not.toBe(waiter);
    for (let n = 0; n < 150; n++) {
      if ((await h.db.sql`select ${blocker}=any(pg_blocking_pids(${waiter})) blocked`)[0].blocked) return;
      await delay(20);
    }
    throw new Error(`Expected PostgreSQL lock wait ${waiter} -> ${blocker} was not observed`);
  }
  async function blocked(firstSql: Sql, secondSql: Sql, firstWork: Work, secondWork: Work, abortFirst = false) {
    const gate = latch(), ready = latch(), queued = latch();
    let holder = 0, waiter = 0, second: Promise<Outcome> | undefined;
    const first = outcome(firstSql.begin(async tx => {
      await tx`set local statement_timeout='8s'`;
      holder = Number((await tx`select pg_backend_pid() p`)[0].p);
      const value = await firstWork(tx); ready.release(); await gate.promise;
      if (abortFirst) throw rollback;
      return value;
    }));
    try {
      await Promise.race([ready.promise, first.then(result => { if (!result.ok) throw result.error; throw new Error('Holder ended before its gate'); })]);
      second = outcome(secondSql.begin(async tx => {
        await tx`set local statement_timeout='8s'`;
        waiter = Number((await tx`select pg_backend_pid() p`)[0].p); queued.release();
        return secondWork(tx);
      }));
      await queued.promise; await waitFor(holder, waiter); gate.release();
      const results = await Promise.all([first, second]); results.forEach(assertNoDeadlock);
      return results;
    } finally {
      gate.release(); await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  }
  async function completeIn(tx: TransactionSql, request: CapturePreparationRequest) {
    await h.prepareCapture(tx, request); return h.applyCapture(tx);
  }
  async function assertCapture(f: Fixture, prior: Awaited<ReturnType<typeof h.captureState>>, ownInbox = f.capture.inboxId, publicationRevisions = 0) {
    const state = await h.captureState(f);
    expect(state).toMatchObject({ roots: 2, manifests: 2, applications: 2, journals: 1, lots: 1, links: 2,
      payment: { status: 'CAPTURED', captured_amount: f.accepted.body.amount }, inbox: { status: ownInbox === f.capture.inboxId ? 'PROCESSED' : 'PROCESSING' } });
    expect(Number(state.payment.version)).toBe(Number(prior.payment.version) + 1);
    expect(BigInt(state.scope.evidence_revision)).toBe(BigInt(prior.scope.evidence_revision) + 1n + BigInt(publicationRevisions));
    const [counts] = await h.db.sql`select
      (select count(*)::int from financial_application_roots where payment_id=${f.paymentId} and family='CAPTURE' and phase='TERMINAL') roots,
      (select count(*)::int from financial_application_revision_effects e join financial_application_roots r on r.id=e.root_id
        where r.payment_id=${f.paymentId} and r.family='CAPTURE') revisions,
      (select count(*)::int from audit_logs where target_id=${f.paymentId} and action='payment.capture_succeeded') audits,
      (select count(*)::int from ledger_entries e join ledger_transactions t on t.id=e.transaction_id
        where t.business_type='CAPTURE' and t.business_id=${f.accepted.body.attemptId}) entries`;
    expect(counts).toEqual({ roots: 1, revisions: 1, audits: 1, entries: 3 });
    const gross = f.accepted.body.amount, fee = 300;
    expect(await h.db.sql`select a.code,a.merchant_id,a.currency,a.account_type,e.debit::text,e.credit::text
      from ledger_entries e join ledger_transactions t on t.id=e.transaction_id join ledger_accounts a on a.id=e.account_id
      where t.business_type='CAPTURE' and t.business_id=${f.accepted.body.attemptId} order by a.code`).toEqual([
      { code: 'MERCHANT_PENDING', merchant_id: f.merchantId, currency: f.currency, account_type: 'LIABILITY', debit: '0', credit: String(gross - fee) },
      { code: 'PLATFORM_FEE_REVENUE', merchant_id: null, currency: f.currency, account_type: 'REVENUE', debit: '0', credit: String(fee) },
      { code: 'PSP_CLEARING', merchant_id: null, currency: f.currency, account_type: 'ASSET', debit: String(gross), credit: '0' },
    ]);
    expect((await h.db.sql`select a.status,l.original_gross::text,l.original_fee::text,l.original_net::text,l.origin,l.settlement_state,l.allocation_revision::int,
      l.capture_journal_id=j.id journal_matches,l.financial_captured_at=j.posted_at timestamp_matches
      from capture_accounting_lots l join payment_attempts a on a.id=l.capture_attempt_id join ledger_transactions j on j.id=l.capture_journal_id
      where l.payment_id=${f.paymentId}`)[0]).toEqual({ status: 'SUCCEEDED', original_gross: String(gross), original_fee: String(fee),
      original_net: String(gross - fee), origin: 'NEW_CAPTURE', settlement_state: 'UNSETTLED', allocation_revision: 0, journal_matches: true, timestamp_matches: true });
  }

  it.each([[true, false], [true, true], [false, false], [false, true]])
    ('serializes same inbox=%s with first abort=%s and applies at most once', async (sameInbox, abortFirst) => {
      const f = await h.fixture(); let peerFixture = f;
      if (!sameInbox) {
        const capture = await h.captureEvidence(f, f.accepted);
        const generation = Number((await h.peer`select public.claim_capture_preparation(${capture.inboxId}) n`)[0].n);
        peerFixture = { ...f, capture, generation };
      }
      const prior = await h.captureState(f), firstRequest = await h.captureRevisions(f), secondRequest = await h.captureRevisions(peerFixture);
      const [one, two] = await blocked(h.worker.sql, h.peer,
        tx => completeIn(tx, firstRequest), tx => completeIn(tx, secondRequest), abortFirst);
      expect(one.ok).toBe(!abortFirst); if (!one.ok) expect(one.error).toBe(rollback);
      expect(two.ok).toBe(abortFirst);
      if (!two.ok) expect(two.error).toBeInstanceOf(Error);
      const appliedInbox = abortFirst ? peerFixture.capture.inboxId : f.capture.inboxId;
      await assertCapture(f, prior, appliedInbox);
      expect((await h.db.sql`select status from webhook_events where id=${appliedInbox}`)[0].status).toBe('PROCESSED');
      if (!sameInbox) {
        const pendingInbox = abortFirst ? f.capture.inboxId : peerFixture.capture.inboxId;
        expect((await h.db.sql`select status from webhook_events where id=${pendingInbox}`)[0].status).toBe('PROCESSING');
        expect(await h.db.sql`select 1 from financial_application_dispositions where inbox_id=${pendingInbox}`).toHaveLength(0);
        await expect(h.inspect(f)).rejects.toThrow(/blocked/);
      }
    });

  it.each([false, true])('binding account UPDATE versus application SHARE (binder first=%s)', async binderFirst => {
    const f = await h.fixture(), equivalent = await h.captureEvidence(f, f.accepted), prior = await h.captureState(f);
    const request = await h.captureRevisions(f);
    const bind: Work = tx => tx`select public.bind_payment_operation_obligation(${equivalent.inboxId},${equivalent.proofId},1)`;
    const [one, two] = await blocked(binderFirst ? h.receipt.correlator : h.worker.sql,
      binderFirst ? h.peer : h.receipt.correlationPeer,
      binderFirst ? bind : tx => completeIn(tx, request), binderFirst ? tx => completeIn(tx, request) : bind);
    expect(one.ok).toBe(true); expect(two.ok).toBe(true); await assertCapture(f, prior);
    expect(await h.db.sql`select 1 from financial_application_dispositions where inbox_id=${equivalent.inboxId}`).toHaveLength(0);
  });

  it.each([false, true])('D02 account UPDATE versus application SHARE (publisher first=%s)', async publisherFirst => {
    const f = await h.fixture(), prior = await h.captureState(f); let active: TransactionSql | undefined;
    // Execute the scripted SDK before financial locks; publication alone is composed into the controlled transaction.
    const database: ObservationTransactions = { transaction: work => active ? work(active) : h.publication.transaction(work) };
    const producer = new TrustedProviderObservations(database, { account: f.account, mode: 'TEST', apiKey: 'sk_test_b2b_concurrency', maxNetworkRetries: 0 },
      new ScriptedStripeHttp(() => ({ body: Buffer.from(JSON.stringify(f.capture.object)), headers: { 'request-id': `req_${f.accepted.body.attemptId}` } })));
    const pending = await producer.execute(f.capture.message), request = await h.captureRevisions(f);
    const publish: Work = async tx => { active = tx; try { return await pending.publish(); } finally { active = undefined; } };
    const [one, two] = await blocked(publisherFirst ? h.observationSql : h.worker.sql,
      publisherFirst ? h.peer : h.observationPeer,
      publisherFirst ? publish : tx => completeIn(tx, request), publisherFirst ? tx => completeIn(tx, request) : publish);
    expect(one.ok).toBe(true);
    if (publisherFirst) {
      expect(two.ok).toBe(false); if (!two.ok) expect(two.error).toBeInstanceOf(Error);
      expect((await h.captureState(f)).payment).toEqual(prior.payment);
      await h.completeCapture(f);
    } else {
      expect(two.ok).toBe(true);
      await expect(h.inspect(f)).rejects.toThrow(/blocked/);
    }
    await assertCapture(f, prior, f.capture.inboxId, 1);
    const sources = await h.db.sql`select o.source_id,exists(select 1 from financial_application_dispositions d where d.observation_source_id=o.source_id) applied
      from provider_observation_obligations o join provider_observation_sources s on s.id=o.source_id where s.outbox_id=${f.capture.outbox.id}`;
    expect(sources).toHaveLength(2); expect(sources.filter(source => source.applied)).toHaveLength(publisherFirst ? 2 : 1);
  });

  it.each([false, true])('signed intake account UPDATE versus application SHARE (publisher first=%s)', async publisherFirst => {
    const f = await h.fixture(), prior = await h.captureState(f), request = await h.captureRevisions(f);
    let active: TransactionSql | undefined, received: SignedReceiptResult | undefined;
    const database: ReceiptTransactions = { transaction: work => {
      if (!active) throw new Error('Controlled publisher transaction required'); return work(active);
    } };
    const receiver = new TrustedSignedReceiptService(database, { account: f.account, webhookSecret: h.receipt.secret,
      admissionContract: 'PAYMENT_OPERATION_V2' }, h.receipt.stripe);
    const raw = Buffer.from(JSON.stringify({ ...f.capture.event, id: `evt_${h.randomUUID()}` })), signed = h.sign(raw);
    const publish: Work = async tx => {
      active = tx; try { received = await receiver.receive(raw, signed.signature); return received; } finally { active = undefined; }
    };
    const [one, two] = await blocked(publisherFirst ? h.receipt.publisher : h.worker.sql,
      publisherFirst ? h.peer : h.receipt.peer,
      publisherFirst ? publish : tx => completeIn(tx, request), publisherFirst ? tx => completeIn(tx, request) : publish);
    expect(one.ok).toBe(true); expect(two.ok).toBe(!publisherFirst);
    if (!received) throw new Error('Signed intake did not commit');
    if (publisherFirst) {
      expect((await h.captureState(f)).payment).toEqual(prior.payment);
      const sealed = await h.evidence.seal(received.id, 0, '0', f.capture.sourceId, f.sourceId);
      expect(sealed.state).toBe('SEALED'); await h.evidence.bind(received.id, sealed.proof_id!, '0');
      await h.completeCapture(f);
    }
    await assertCapture(f, prior, f.capture.inboxId, publisherFirst ? 1 : 0);
    expect(await h.db.sql`select 1 from financial_application_dispositions where inbox_id=${received.id}`).toHaveLength(0);
    expect((await h.db.sql`select status from webhook_events where id=${received.id}`)[0].status).toBe('PENDING');
    await expect(h.inspect(f)).rejects.toThrow(/blocked/);
  });

  it('fences a stale reclaimed generation even when it waits behind a successful current worker', async () => {
    const f = await h.fixture(), stale = await h.captureRevisions(f), prior = await h.captureState(f);
    await h.db.sql`alter table webhook_events disable trigger capture_preparation_write`;
    try { await h.db.sql`update webhook_events set locked_at=now()-interval '3 minutes' where id=${f.capture.inboxId}`; }
    finally { await h.db.sql`alter table webhook_events enable trigger capture_preparation_write`; }
    const generation = Number((await h.peer`select public.claim_capture_preparation(${f.capture.inboxId}) n`)[0].n);
    expect(generation).toBe(f.generation + 1);
    const current = await h.captureRevisions({ ...f, generation });
    const [one, two] = await blocked(h.peer, h.worker.sql, tx => completeIn(tx, current), tx => completeIn(tx, stale));
    expect(one.ok).toBe(true); expect(two.ok).toBe(false); await assertCapture(f, prior);
    expect((await h.db.sql`select status,attempts from webhook_events where id=${f.capture.inboxId}`)[0]).toEqual({ status: 'PROCESSED', attempts: generation });
  });

  it('keeps payment NO KEY UPDATE compatible with the legacy attempt then payment FK KEY SHARE edge', async () => {
    const f = await h.fixture(), prior = await h.captureState(f), request = await h.captureRevisions(f);
    let keyShareFinished = false;
    const gate = latch(), ready = latch(); let holder = 0, waiter = 0, second: Promise<Outcome> | undefined;
    const first = outcome(h.db.sql.begin(async tx => {
      await tx`set local statement_timeout='8s'`; holder = Number((await tx`select pg_backend_pid() p`)[0].p);
      await tx`select 1 from payment_attempts where id=${f.accepted.body.attemptId} for update`; ready.release(); await gate.promise;
      await tx`select 1 from payments where id=${f.paymentId} for key share`; keyShareFinished = true;
    }));
    try {
      await Promise.race([ready.promise, first.then(result => { if (!result.ok) throw result.error; })]);
      const queued = latch(); second = outcome(h.worker.sql.begin(async tx => {
        await tx`set local statement_timeout='8s'`; waiter = Number((await tx`select pg_backend_pid() p`)[0].p); queued.release();
        return completeIn(tx, request);
      }));
      await queued.promise; await waitFor(holder, waiter); gate.release();
      const results = await Promise.all([first, second]); results.forEach(assertNoDeadlock);
      expect(results.map(result => result.ok)).toEqual([true, true]); expect(keyShareFinished).toBe(true);
    } finally { gate.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
    await assertCapture(f, prior);
  });

  it.each([false, true])('two SQL merchants resolve shared cold platform accounts (reverse=%s)', async reverse => {
    const currency = coldCurrency(), f = await h.fixture({ currency }), other = await h.fixture({ currency });
    expect(await h.db.sql`select 1 from ledger_accounts where merchant_id is null and currency=${currency}`).toHaveLength(0);
    const first = reverse ? other : f, second = reverse ? f : other;
    const before = await h.captureState(f), otherBefore = await h.captureState(other);
    const oneRequest = await h.captureRevisions(first), twoRequest = await h.captureRevisions(second);
    const results = await blocked(h.worker.sql, h.peer, tx => completeIn(tx, oneRequest), tx => completeIn(tx, twoRequest));
    expect(results.map(result => result.ok)).toEqual([true, true]);
    await assertCapture(f, before); await assertCapture(other, otherBefore);
    expect(await h.db.sql`select code from ledger_accounts where merchant_id is null and currency=${currency} order by code`)
      .toEqual([{ code: 'PLATFORM_FEE_REVENUE' }, { code: 'PSP_CLEARING' }]);
  });

  async function legacyFixture(currency: string) {
    const merchantId = h.randomUUID(), paymentId = h.randomUUID(), attemptId = h.randomUUID(), pi = `pi_${h.randomUUID().replaceAll('-', '')}`;
    await h.db.sql`insert into merchants(id,name,fee_bps,settlement_delay_days) values(${merchantId},'Unenrolled legacy capture',300,2)`;
    await h.db.sql`insert into payments(id,merchant_id,status,capture_method,currency,amount,authorized_amount,payment_method_token)
      values(${paymentId},${merchantId},'CAPTURE_PENDING','MANUAL',${currency},10000,10000,'pm_fixture')`;
    await h.db.sql`insert into payment_attempts(id,merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id)
      values(${attemptId},${merchantId},${paymentId},'CAPTURE','PROCESSING',10000,${currency},${pi})`;
    await h.db.sql`insert into provider_transactions(merchant_id,payment_id,payment_attempt_id,provider,provider_transaction_id,payment_intent_id,
      provider_idempotency_key,operation,status,amount,currency,last_synced_at)
      values(${merchantId},${paymentId},${attemptId},'STRIPE',${pi},${pi},${`capture:${attemptId}`},'CAPTURE','succeeded',10000,${currency},now())`;
    const ledger = new LedgerService(h.db), outbox = new OutboxService(), audit = new AuditService();
    const business = new WebhookBusinessService(ledger, outbox, audit,
      new RefundsService(h.db, new IdempotencyService(h.db), outbox, audit, ledger), new DisputesService(ledger, audit));
    const event: ProviderEvent = { id: `evt_${h.randomUUID()}`, type: 'payment.capture_succeeded', externalType: 'payment_intent.succeeded',
      createdAt: new Date().toISOString(), data: { merchantId, paymentId, attemptId, providerTransactionId: pi, paymentIntentId: pi,
        chargeId: `ch_${h.randomUUID().replaceAll('-', '')}`, amount: 10000, currency, providerStatus: 'succeeded' } };
    expect(await h.db.sql`select 1 from financial_application_scope_authority where merchant_id=${merchantId}`).toHaveLength(0);
    return { merchantId, paymentId, attemptId, apply: (tx: TransactionSql) => business.handle(tx, event) };
  }

  it.each([false, true])('SQL and actual unenrolled legacy capture create shared cold accounts (legacy first=%s)', async legacyFirst => {
    const currency = coldCurrency(), f = await h.fixture({ currency }), legacy = await legacyFixture(currency);
    const prior = await h.captureState(f), request = await h.captureRevisions(f);
    expect(await h.db.sql`select 1 from ledger_accounts where merchant_id is null and currency=${currency}`).toHaveLength(0);
    const results = await blocked(legacyFirst ? h.db.sql : h.worker.sql, legacyFirst ? h.peer : h.db.sql,
      legacyFirst ? legacy.apply : tx => completeIn(tx, request), legacyFirst ? tx => completeIn(tx, request) : legacy.apply);
    expect(results.map(result => result.ok)).toEqual([true, true]); await assertCapture(f, prior);
    expect((await h.db.sql`select status,captured_amount::text,platform_fee_amount::text from payments where id=${legacy.paymentId}`)[0])
      .toEqual({ status: 'CAPTURED', captured_amount: '10000', platform_fee_amount: '300' });
    expect(await h.db.sql`select 1 from capture_accounting_lots where payment_id=${legacy.paymentId} and original_gross=10000 and original_fee=300 and original_net=9700`).toHaveLength(1);
    expect(await h.db.sql`select 1 from ledger_transactions where business_type='CAPTURE' and business_id=${legacy.attemptId} and status='POSTED'`).toHaveLength(1);
    expect(await h.db.sql`select 1 from financial_application_roots where payment_id=${legacy.paymentId}`).toHaveLength(0);
    expect(await h.db.sql`select code from ledger_accounts where merchant_id is null and currency=${currency} order by code`)
      .toEqual([{ code: 'PLATFORM_FEE_REVENUE' }, { code: 'PSP_CLEARING' }]);
  });

  it.each([false, true])('account identity mutation serializes with posting SHARE (mutation first=%s)', async mutationFirst => {
    const currency = coldCurrency(), f = await h.fixture({ currency }), prior = await h.captureState(f), request = await h.captureRevisions(f);
    const [account] = await h.db.sql<{ id: string }[]>`insert into ledger_accounts(merchant_id,code,account_type,currency,name)
      values(null,'PSP_CLEARING','ASSET',${currency},'Preserve this custom label') returning id`;
    const mutate: Work = async tx => { await tx`update ledger_accounts set account_type='REVENUE' where id=${account.id}`; if (!mutationFirst) throw rollback; };
    const [one, two] = await blocked(mutationFirst ? h.db.sql : h.worker.sql, mutationFirst ? h.peer : h.db.sql,
      mutationFirst ? mutate : tx => completeIn(tx, request), mutationFirst ? tx => completeIn(tx, request) : mutate);
    expect(one.ok).toBe(true); expect(two.ok).toBe(false);
    if (mutationFirst) expect((await h.captureState(f)).payment).toEqual(prior.payment);
    else { if (!two.ok) expect(two.error).toBe(rollback); await assertCapture(f, prior); }
    expect((await h.db.sql`select name from ledger_accounts where id=${account.id}`)[0].name).toBe('Preserve this custom label');
  });

  it('allows an independent currency to commit while the first currency application is held', async () => {
    const f = await h.fixture({ currency: coldCurrency() }), other = await h.fixture({ currency: coldCurrency() });
    const prior = await h.captureState(f), otherPrior = await h.captureState(other), request = await h.captureRevisions(f), otherRequest = await h.captureRevisions(other);
    const gate = latch(), ready = latch(), queued = latch(); let holder = 0, waiter = 0, second: Promise<Outcome> | undefined;
    const first = outcome(h.worker.sql.begin(async tx => {
      await tx`set local statement_timeout='8s'`; holder = Number((await tx`select pg_backend_pid() p`)[0].p);
      await completeIn(tx, request); ready.release(); await gate.promise;
    }));
    try {
      await Promise.race([ready.promise, first.then(result => { if (!result.ok) throw result.error; })]);
      second = outcome(h.peer.begin(async tx => {
        await tx`set local statement_timeout='8s'`; waiter = Number((await tx`select pg_backend_pid() p`)[0].p); queued.release();
        return completeIn(tx, otherRequest);
      }));
      await queued.promise; expect(holder).not.toBe(waiter);
      expect((await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) blocked`)[0].blocked).toBe(false);
      const result = await Promise.race([second, delay(3000).then(() => { throw new Error('Independent currency did not commit before release'); })]);
      assertNoDeadlock(result); expect(result.ok).toBe(true); await assertCapture(other, otherPrior);
      gate.release(); expect((await first).ok).toBe(true);
    } finally { gate.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
    await assertCapture(f, prior);
  });

  it('applies the frozen SQL term snapshot after a concurrent merchant terms update', async () => {
    const f = await h.fixture(), prior = await h.captureState(f), request = await h.captureRevisions(f);
    await h.worker.sql.begin(async tx => {
      await h.prepareCapture(tx, request);
      const holder = Number((await tx`select pg_backend_pid() p`)[0].p);
      const [editor] = await h.db.sql`update merchants set fee_bps=500,fixed_fee_minor=12,settlement_delay_days=9
        where id=${f.merchantId} returning pg_backend_pid() p`;
      expect(Number(editor.p)).not.toBe(holder);
      expect((await h.readCapture(tx))[0].plan.source_manifest.money.fee).toBe(300);
      await h.applyCapture(tx);
    });
    await assertCapture(f, prior);
    expect((await h.db.sql`select original_fee::text,original_net::text,
      extract(epoch from eligible_at-financial_captured_at)::text delay_seconds from capture_accounting_lots where payment_id=${f.paymentId}`)[0])
      .toEqual({ original_fee: '300', original_net: '9700', delay_seconds: '172800.000000' });
  });
});
