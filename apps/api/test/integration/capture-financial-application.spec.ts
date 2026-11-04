import type { TransactionSql } from 'postgres';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { ScriptedStripeHttp } from '../support/provider-observation-harness';
import type { IntentVariant } from '../support/first-capture-intent-harness';
import type { CapturePreparationRequest } from '../support/capture-preparation-harness';
import { captureFinancialApplicationHarness, type CaptureApplicationPlan, type CaptureRow } from '../support/capture-financial-application-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30000);

describeDb('B2-B atomic first capture financial application', () => {
  let h: Awaited<ReturnType<typeof captureFinancialApplicationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  beforeAll(async () => { h = await captureFinancialApplicationHarness(); await h.install(); });
  afterAll(async () => { if (h) await h.close(); });

  async function refused(f: Fixture, request?: CapturePreparationRequest) {
    const before = await h.captureState(f);
    await expect(h.completeCapture(f, h.worker.sql, request)).rejects.toThrow();
    expect(await h.captureState(f)).toEqual(before);
  }
  async function insert(tx: TransactionSql, table: string, row: CaptureRow) {
    await tx.unsafe(`insert into public.${table} select (jsonb_populate_record(null::public.${table},$1::text::jsonb)).*`, [JSON.stringify(row)]);
  }
  async function raw(table: string, action: () => Promise<unknown>) {
    await h.db.sql.unsafe(`grant insert,update,select on public.${table} to "${h.worker.role}"`);
    try { await action(); }
    finally { await h.db.sql.unsafe(`revoke insert,update,select on public.${table} from "${h.worker.role}"`); }
  }
  async function exactRows(plan: CaptureApplicationPlan) {
    // A journal has intermediate DRAFT images; only its final image persists.
    const final = new Map(plan.effect_manifest.map(effect => [effect.table + ':' + effect.id, effect]));
    for (const effect of final.values()) {
      const [actual] = await h.db.sql<{ row: CaptureRow }[]>`select to_jsonb(t) row from ${h.db.sql('public.' + effect.table)} t where id=${effect.id}`;
      expect(actual.row).toEqual(effect.after);
    }
    for (const effect of plan.source_manifest.completion) {
      const key = effect.table === 'financial_applications' ? 'root_id' : effect.table === 'financial_application_revision_effects' ? 'manifest_id'
        : effect.table === 'financial_application_effect_links' ? 'effect_id' : 'id';
      const [actual] = await h.db.sql<{ row: CaptureRow }[]>`select to_jsonb(t) row from ${h.db.sql('public.' + effect.table)} t where ${h.db.sql(key)}=${effect.id}`;
      expect(actual.row).toEqual(effect.after);
    }
    for (const account of plan.source_manifest.accounts) {
      const [actual] = await h.db.sql<{ row: CaptureRow }[]>`select to_jsonb(a) row from ledger_accounts a where id=${String(account.row.id)}`;
      expect(actual.row).toEqual(account.row);
    }
  }
  async function completedPlan(f: Fixture, immediate = false, timezone = 'UTC') {
    const request = await h.captureRevisions(f); let plan!: CaptureApplicationPlan;
    const [result] = await h.worker.sql.begin(async tx => {
      await tx`select set_config('TimeZone',${timezone},true)`;
      await h.prepareCapture(tx, request); plan = (await h.readCapture(tx))[0].plan;
      const result = await h.applyCapture(tx);
      if (immediate) await tx`set constraints all immediate`;
      return result;
    });
    expect(result.id).toBe(plan.root_id); return plan;
  }
  async function lines(f: Fixture) {
    return h.db.sql<{ code: string; merchant_id: string | null; account_type: string; currency: string; debit: string; credit: string }[]>`select a.code,a.merchant_id,a.account_type,e.currency,e.debit::text,e.credit::text
      from ledger_entries e join ledger_accounts a on a.id=e.account_id join ledger_transactions j on j.id=e.transaction_id
      where j.business_type='CAPTURE' and j.business_id=${f.accepted.body.attemptId} order by a.code`;
  }
  it.each<[IntentVariant, number, number]>([['FULL', 10000, 300], ['FIRST_PARTIAL', 4000, 120], ['FINAL_PARTIAL', 4000, 120]])
    ('commits %s through genuine P-B/P-C/scripted D02/signed B1 with every exact row', async (variant, gross, fee) => {
      const f = await h.fixture({ variant, gross }), before = await h.captureState(f), request = await h.captureRevisions(f);
      const plan = await completedPlan(f, true), after = await h.captureState(f);
      expect(plan).toMatchObject({ proof_kind: 'PAYMENT_OPERATION_V1', result: 'POSTED', payment_operation_proof_id: f.capture.proofId,
        source_manifest: { contract: 'CAPTURE_APPLICATION_V1', executable: true, money: { C0: 0, F0: 0, C1: gross, F1: fee, gross, fee, net: gross - fee } } });
      await exactRows(plan);
      expect(after).toMatchObject({ roots: 2, manifests: 2, applications: 2, preparations: 1, journals: 1, lots: 1, links: 2,
        payment: { status: 'CAPTURED', captured_amount: gross, platform_fee_amount: fee, refunded_amount: 0 },
        inbox: { status: 'PROCESSED', attempts: f.generation, locked_at: null } });
      expect((after.payment as CaptureRow).version).toBe(Number((before.payment as CaptureRow).version) + 1);
      expect(BigInt(after.scope.evidence_revision)).toBe(BigInt(request.scope) + 1n);
      expect(after.intake).toBe(before.intake); expect(after.receipts).toEqual(before.receipts); expect(after.sources).toEqual(before.sources);
      expect(after.application_rows).toHaveLength(1); expect(after.disposition_rows).toHaveLength(2); expect(after.revision_rows).toHaveLength(1);
      expect(await lines(f)).toEqual([
        { code: 'MERCHANT_PENDING', merchant_id: f.merchantId, account_type: 'LIABILITY', currency: f.currency, debit: '0', credit: String(gross - fee) },
        { code: 'PLATFORM_FEE_REVENUE', merchant_id: null, account_type: 'REVENUE', currency: f.currency, debit: '0', credit: String(fee) },
        { code: 'PSP_CLEARING', merchant_id: null, account_type: 'ASSET', currency: f.currency, debit: String(gross), credit: '0' },
      ]);
      const [lot] = await h.db.sql`select original_gross::text,original_fee::text,original_net::text,origin,policy_version,settlement_state,
        allocation_revision::text,finalized_settlement_item_id,financial_captured_at=(${plan.source_manifest.applied_at}::text)::timestamptz exact_stamp,
        financial_captured_at=(select posted_at from ledger_transactions where id=capture_journal_id) exact_posted,
        extract(epoch from eligible_at-financial_captured_at)::text seconds from capture_accounting_lots where payment_id=${f.paymentId}`;
      expect(lot).toMatchObject({ original_gross: String(gross), original_fee: String(fee), original_net: String(gross - fee), origin: 'NEW_CAPTURE',
        policy_version: 'CAPTURE_FIFO_V1', settlement_state: 'UNSETTLED', allocation_revision: '0', finalized_settlement_item_id: null,
        exact_stamp: true, exact_posted: true }); expect(Number(lot.seconds)).toBe(172800);
      await h.inspect(f);
      expect(f.capture.transport.calls).toHaveLength(1);
    });
  it.each([[1, 300, '0', 0], [100, 0, '200', 100], [4000, 300, '30', 150], [333, 333, '7', 18], [9007199254740991, 0, '0', 0]] as const)
    ('posts only positive legs for G=%s bps=%s fixed=%s', async (gross, bps, fixed, fee) => {
      const f = await h.fixture({ authorized: gross, bps, fixed, currency: 'EUR' }), plan = await completedPlan(f);
      expect(plan.source_manifest.money).toMatchObject({ gross, fee, net: gross - fee });
      await exactRows(plan); const posted = await lines(f);
      expect(posted).toHaveLength(1 + Number(gross > fee) + Number(fee > 0));
      expect(posted.map(l => l.code).sort()).toEqual(['PSP_CLEARING', ...(gross > fee ? ['MERCHANT_PENDING'] : []), ...(fee > 0 ? ['PLATFORM_FEE_REVENUE'] : [])].sort());
      expect(await h.db.sql`select 1 from ledger_entries e join ledger_transactions j on j.id=e.transaction_id join ledger_accounts a on a.id=e.account_id
        where j.merchant_id=${f.merchantId} and a.code in ('MERCHANT_AVAILABLE','PLATFORM_CASH')`).toHaveLength(0);
    });
  it.each([{ authorized: 9007199254740991, bps: 300 }, { fixed: '9007199254740991' }, { fixed: '-1' }, { days: -1 }, { days: 2147483647 }])
    ('rejects incompatible numeric or timestamp bounds %j before effects', async options => { await refused(await h.fixture(options)); });
  it('preserves the compatible product boundary rather than using wider SQL arithmetic', async () => {
    const gross = Math.floor(Number.MAX_SAFE_INTEGER / 300), f = await h.fixture({ authorized: gross });
    await h.completeCapture(f); expect((await h.captureState(f)).payment).toMatchObject({ platform_fee_amount: Number(BigInt(gross) * 300n / 10000n) });
    await refused(await h.fixture({ authorized: gross + 1 }));
  });
  it('preserves nondefault account names and complete existing account rows', async () => {
    const f = await h.fixture({ currency: 'GBP' });
    await h.db.sql`insert into ledger_accounts(merchant_id,code,account_type,currency,name)
      values(null,'PSP_CLEARING','ASSET','GBP','Existing PSP label'),(${f.merchantId},'MERCHANT_PENDING','LIABILITY','GBP','Custom merchant label'),
        (null,'PLATFORM_FEE_REVENUE','REVENUE','GBP','Historic fee label') on conflict do nothing`;
    const before = await h.db.sql`select to_jsonb(a) row from ledger_accounts a where currency='GBP' order by id`, plan = await completedPlan(f);
    expect(plan.source_manifest.accounts.every(a => !a.created)).toBe(true); await exactRows(plan);
    expect(await h.db.sql`select to_jsonb(a) row from ledger_accounts a where currency='GBP' order by id`).toEqual(before);
  });
  it('refuses a conflicting account type instead of repurposing the existing identity', async () => {
    const f = await h.fixture({ currency: 'CAD' });
    await h.db.sql`insert into ledger_accounts(merchant_id,code,account_type,currency,name) values(${f.merchantId},'MERCHANT_PENDING','ASSET','CAD','Conflicting fixture')`;
    const before = await h.db.sql`select to_jsonb(a) row from ledger_accounts a where currency='CAD' order by id`;
    await refused(f); expect(await h.db.sql`select to_jsonb(a) row from ledger_accounts a where currency='CAD' order by id`).toEqual(before);
  });
  it('keeps SQL timestamp microseconds and 24-hour eligibility under different session timezones', async () => {
    const f = await h.fixture({ days: 3 }), request = await h.captureRevisions(f), retry = new Error('select a submillisecond fixture timestamp');
    let plan: CaptureApplicationPlan | undefined;
    for (let n = 0; n < 5 && !plan; n++) {
      try {
        await h.worker.sql.begin(async tx => {
          await tx`set local timezone='America/New_York'`; await h.prepareCapture(tx, request);
          const issued = (await h.readCapture(tx))[0].plan;
          if (Number((await tx`select extract(microseconds from (${issued.source_manifest.applied_at}::text)::timestamptz)::bigint%1000 n`)[0].n) === 0) throw retry;
          await h.applyCapture(tx); await tx`set constraints all immediate`; plan = issued;
        });
      } catch (error) { if (error !== retry) throw error; }
    }
    if (!plan) throw new Error('Could not obtain a submillisecond PostgreSQL timestamp');
    const [time] = await h.db.sql`select posted_at=(${plan.source_manifest.applied_at}::text)::timestamptz exact,
      to_char(posted_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') stored,
      to_char((${plan.source_manifest.applied_at}::text)::timestamptz at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') issued,
      extract(epoch from l.eligible_at-l.financial_captured_at)::int seconds from ledger_transactions j join capture_accounting_lots l on l.capture_journal_id=j.id where l.payment_id=${f.paymentId}`;
    expect(time.exact).toBe(true); expect(time.stored).toBe(time.issued); expect(time.seconds).toBe(259200);
  });
  it('claims a genuine capture in a non-UTC worker session', async () => {
    const f = await h.fixture(), peer = await h.captureEvidence(f, f.accepted);
    await h.worker.sql`set timezone='America/New_York'`;
    try {
      expect(Number((await h.worker.sql`select public.claim_capture_preparation(${peer.inboxId}) n`)[0].n)).toBe(1);
    } finally { await h.worker.sql`set timezone='UTC'`; }
  });
  it('normalizes only typed timestamp instants without weakening other exact image values', async () => {
    const [row] = await h.db.sql`with images as (select
      '{"created_at":"2026-03-08T01:59:59.123456-05:00","amount":100,"payload":{"at":"2026-03-08T01:59:59.123456-05:00"}}'::jsonb a,
      '{"created_at":"2026-03-08T06:59:59.123456+00:00","amount":100,"payload":{"at":"2026-03-08T01:59:59.123456-05:00"}}'::jsonb b)
      select public.financial_image_at_utc('payments',a)=public.financial_image_at_utc('payments',b) same_instant,
        public.financial_image_at_utc('payments',a)<>public.financial_image_at_utc('payments',b||'{"created_at":"2026-03-08T06:59:59.123457+00:00"}') microsecond_drift,
        public.financial_image_at_utc('payments',a)<>public.financial_image_at_utc('payments',b||'{"amount":101}') money_drift,
        public.financial_image_at_utc('payments',a)<>public.financial_image_at_utc('payments',b-'amount') missing_key,
        public.financial_image_at_utc('payments',a)<>public.financial_image_at_utc('payments',b||'{"payload":{"at":"2026-03-08T06:59:59.123456+00:00"}}') payload_drift from images`;
    expect(row).toEqual({ same_instant: true, microsecond_drift: true, money_drift: true, missing_key: true, payload_drift: true });
  });
  it('applies a complete non-UTC P-B/P-C history and claim through UTC capture validation', async () => {
    await h.worker.sql`set timezone='America/New_York'`;
    try {
      const f = await h.fixture({ claim: false });
      await h.worker.sql`set timezone='UTC'`;
      f.generation = Number((await h.worker.sql`select public.claim_capture_preparation(${f.capture.inboxId}) n`)[0].n);
      await h.worker.sql`set timezone='America/New_York'`;
      const plan = await completedPlan(f, true, 'Asia/Bangkok');
      await exactRows(plan);
      expect((await h.db.sql`select public.manual_authorization_history(${f.rootId}) valid`)[0].valid).toBe(true);
      await expect(h.inspect(f)).resolves.toHaveLength(1);
    } finally { await h.worker.sql`set timezone='UTC'`; }
  });
  it('uses frozen terms if the merchant changes after preparation', async () => {
    const f = await h.fixture(), r = await h.captureRevisions(f);
    await h.worker.sql.begin(async tx => {
      await h.prepareCapture(tx, r); await h.db.sql`update merchants set fee_bps=500,fixed_fee_minor=12,settlement_delay_days=9 where id=${f.merchantId}`;
      expect((await h.readCapture(tx))[0].plan.source_manifest.money.fee).toBe(300); await h.applyCapture(tx);
    });
    expect((await h.captureState(f)).payment).toMatchObject({ platform_fee_amount: 300 });
    expect(Number((await h.db.sql`select extract(epoch from eligible_at-financial_captured_at) n from capture_accounting_lots where payment_id=${f.paymentId}`)[0].n)).toBe(172800);
  });
  it('clears only covered sources and its own receipt; equivalent peers stay pending and blocking', async () => {
    const f = await h.fixture(), peer = await h.captureEvidence(f, f.accepted), plan = await completedPlan(f);
    expect(plan.source_manifest.inventory.sources).toHaveLength(2); expect(plan.source_manifest.inventory.receipts).toHaveLength(2);
    const dispositions = await h.db.sql<{ inbox_id: string | null; observation_source_id: string | null; disposition: string }[]>`select inbox_id,observation_source_id,disposition from financial_application_dispositions where root_id=${plan.root_id}`;
    expect(dispositions).toHaveLength(3); expect(dispositions.every(d => d.disposition === 'APPLIED')).toBe(true);
    expect(dispositions.filter(d => d.inbox_id).map(d => d.inbox_id)).toEqual([f.capture.inboxId]);
    expect(dispositions.filter(d => d.observation_source_id).map(d => d.observation_source_id).sort()).toEqual([f.capture.sourceId, peer.sourceId].sort());
    expect((await h.db.sql`select status from webhook_events where id=${peer.inboxId}`)[0].status).toBe('PENDING');
    await expect(h.inspect(f)).rejects.toThrow(/blocked/);
    const generation = Number((await h.peer`select public.claim_capture_preparation(${peer.inboxId}) n`)[0].n);
    await refused({ ...f, capture: peer, generation });
  });
  it('recognizes completed capture causes consistently when a second independent payment uses the same scope', async () => {
    const { first, next } = await h.fixturePair(); await h.completeCapture(first); const original = await h.captureState(first);
    const second = await next(); expect(second.paymentId).not.toBe(first.paymentId); expect(second.merchantId).toBe(first.merchantId);
    const plan = await completedPlan(second, true); expect(plan.source_manifest.inventory.sources).toHaveLength(1);
    await exactRows(plan); await h.inspect(second);
    expect((await h.captureState(first)).payment).toEqual(original.payment);
    expect(await h.db.sql`select 1 from financial_application_roots where merchant_id=${first.merchantId} and family='CAPTURE' and phase='TERMINAL'`).toHaveLength(2);
  });
  it.each(['capture-source', 'auth-source', 'unbound-receipt', 'delivery-barrier', 'exception'] as const)
    ('a later %s remains independently blocking after capture commits', async kind => {
      const f = await h.fixture(); await h.completeCapture(f); await h.inspect(f);
      if (kind === 'capture-source') {
        const producer = new TrustedProviderObservations(h.publication, { account: f.account, mode: 'TEST', apiKey: 'sk_test_b2b_fixture', maxNetworkRetries: 0 },
          new ScriptedStripeHttp(() => ({ body: Buffer.from(JSON.stringify(f.capture.object)), headers: { 'request-id': `req_${f.accepted.body.attemptId}` } })));
        await (await producer.execute(f.capture.message)).publish();
      } else if (kind === 'auth-source') await (await f.exchange()).publish();
      else if (kind === 'unbound-receipt') await f.receive({ ...f.capture.event, id: `evt_${h.randomUUID()}` });
      else if (kind === 'delivery-barrier') await f.receive({ ...f.capture.event, data: { object: { ...f.capture.object, amount_received: 9999 } } });
      else await h.db.sql`insert into accounting_exceptions(merchant_id,currency,payment_id,category,source_kind,evidence_key,observed_conflict)
        values(${f.merchantId},${f.currency},${f.paymentId},'AMBIGUOUS_PROVIDER_NET_EFFECT','INTERNAL',${h.randomUUID()},'{}')`;
      const before = await h.captureState(f); await expect(h.inspect(f)).rejects.toThrow(/blocked/);
      await refused(f); expect(await h.captureState(f)).toEqual(before);
    });
  it.each(['unbound', 'contradictory', 'unknown-command', 'extra-authorization', 'exception'] as const)
    ('a preapplication %s cause refuses the latest executable path without clearing evidence', async kind => {
      const f = await h.fixture();
      if (kind === 'unbound') await f.receive({ ...f.capture.event, id: `evt_${h.randomUUID()}` });
      else if (kind === 'contradictory') await f.receive({ ...f.capture.event, id: `evt_${h.randomUUID()}`,
        data: { object: { ...f.capture.object, amount_received: 9999 } } });
      else if (kind === 'extra-authorization') await (await f.exchange()).publish();
      else if (kind === 'unknown-command') {
        const producer = new TrustedProviderObservations(h.publication, { account: f.account, mode: 'TEST', apiKey: 'sk_test_b2b_fixture', maxNetworkRetries: 0 },
          new ScriptedStripeHttp(() => new Error('isolated unknown capture result')));
        await (await producer.execute(f.capture.message)).publish();
      } else await h.db.sql`insert into accounting_exceptions(merchant_id,currency,payment_id,category,source_kind,evidence_key,observed_conflict)
        values(${f.merchantId},${f.currency},${f.paymentId},'AMBIGUOUS_PROVIDER_NET_EFFECT','INTERNAL',${h.randomUUID()},'{}')`;
      await refused(f); await expect(h.inspect(f)).rejects.toThrow(/blocked/);
    });
  it.each(['intent', 'inbox', 'proof', 'generation', 'obligation', 'scope', 'intake'] as const)
    ('rejects wrong/stale %s without any economic or finality delta', async key => {
      const f = await h.fixture(), r = await h.captureRevisions(f);
      await refused(f, { ...r, [key]: key === 'generation' ? 0 : ['obligation', 'scope', 'intake'].includes(key) ? '-1' : h.randomUUID() });
    });
  it.each(['repeatable read', 'serializable'])('refuses unsupported %s isolation', async isolation => {
    const f = await h.fixture(), r = await h.captureRevisions(f), before = await h.captureState(f);
    await expect(h.worker.sql.begin(async tx => { await tx.unsafe(`set transaction isolation level ${isolation}`); await h.completeCaptureIn(tx, r); })).rejects.toThrow(/READ COMMITTED/);
    expect(await h.captureState(f)).toEqual(before);
  });
  it.each([false, true])('prepare-only cannot commit (explicit immediate=%s)', async immediate => {
    const f = await h.fixture({ currency: 'AUD' }), r = await h.captureRevisions(f), before = await h.captureState(f);
    const accounts = await h.db.sql`select to_jsonb(a) row from ledger_accounts a where currency='AUD' order by id`;
    await expect(h.worker.sql.begin(async tx => { await h.prepareCapture(tx, r); if (immediate) await tx`set constraints all immediate`; })).rejects.toThrow();
    expect(await h.captureState(f)).toEqual(before); expect(await h.db.sql`select to_jsonb(a) row from ledger_accounts a where currency='AUD' order by id`).toEqual(accounts);
  });
  it('autocommit and an all-immediate start refuse incomplete financial authority', async () => {
    const f = await h.fixture(), r = await h.captureRevisions(f), before = await h.captureState(f);
    await expect(h.worker.sql`select public.prepare_capture_application(${r.intent},${r.inbox},${r.proof},${r.generation},${r.obligation},${r.scope},${r.intake})`).rejects.toThrow();
    await expect(h.worker.sql.begin(async tx => { await tx`set constraints all immediate`; await h.completeCaptureIn(tx, r); })).rejects.toThrow();
    expect(await h.captureState(f)).toEqual(before);
  });
  it('savepoint rollback destroys authority and all account/effect writes before a fresh complete apply', async () => {
    const f = await h.fixture(), r = await h.captureRevisions(f), rollback = new Error('fixture savepoint rollback'); let first = '';
    await h.worker.sql.begin(async tx => {
      try { await tx.savepoint(async sub => { first = (await h.prepareCapture(sub, r))[0].id; await h.applyCapture(sub); throw rollback; }); }
      catch (error) { if (error !== rollback) throw error; }
      await expect(tx.savepoint(sub => h.readCapture(sub))).rejects.toThrow();
      const [prepared] = await h.prepareCapture(tx, r); expect(prepared.id).not.toBe(first); await h.applyCapture(tx);
    });
    expect(await h.captureState(f)).toMatchObject({ journals: 1, lots: 1, links: 2, preparations: 1, applications: 2 });
  });
  it('fences other backends/principals and cannot use a GUC as a permit', async () => {
    const f = await h.fixture(), r = await h.captureRevisions(f), stranger = await h.login('capture_apply_stranger');
    await h.db.sql.unsafe(`grant execute on function public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint),public.apply_capture_application() to "${stranger.role}"`);
    await expect(h.completeCapture(f, stranger.sql, r)).rejects.toThrow(/genuine capture claim/);
    await expect(h.peer.begin(async tx => { await tx`select set_config('app.financial_permit','{"approved":true}',true)`; await h.applyCapture(tx); })).rejects.toThrow();
    const rollback = new Error('rollback');
    try { await h.worker.sql.begin(async tx => { await h.prepareCapture(tx, r); await expect(h.applyCapture(h.peer as unknown as TransactionSql)).rejects.toThrow(); throw rollback; }); }
    catch (error) { if (error !== rollback) throw error; }
    await h.completeCapture(f);
  });
  it('refuses second apply/advance and preserves the committed claim against stale bookkeeping', async () => {
    const f = await h.fixture(), r = await h.captureRevisions(f);
    await h.db.sql.unsafe(`grant execute on function public.advance_financial_application_revision() to "${h.worker.role}"`);
    await expect(h.worker.sql.begin(async tx => { await h.completeCaptureIn(tx, r); await h.applyCapture(tx); })).rejects.toThrow();
    await expect(h.worker.sql.begin(async tx => { await h.completeCaptureIn(tx, r); await tx`select public.advance_financial_application_revision()`; })).rejects.toThrow();
    await h.completeCapture(f); const before = await h.captureState(f); await refused(f, r);
    await expect(h.worker.sql`select public.claim_capture_preparation(${f.capture.inboxId})`).rejects.toThrow(/claimable/);
    await raw('webhook_events', async () => { await expect(h.worker.sql`update webhook_events set status='RETRY',attempts=attempts+1,locked_at=null where id=${f.capture.inboxId}`).rejects.toThrow(); });
    expect(await h.captureState(f)).toEqual(before);
    await h.db.sql.unsafe(`revoke execute on function public.advance_financial_application_revision() from "${h.worker.role}"`);
  });
  it.each(['captured_amount', 'platform_fee_amount', 'version'] as const)('the exact manifest refuses an unplanned payment %s', async column => {
    const f = await h.fixture(), r = await h.captureRevisions(f), before = await h.captureState(f);
    await raw('payments', async () => {
      await expect(h.worker.sql.begin(async tx => { await h.prepareCapture(tx, r); await tx.unsafe(`update public.payments set ${column}=${column}+1 where id=$1`, [f.paymentId]); })).rejects.toThrow();
    }); expect(await h.captureState(f)).toEqual(before);
  });
  it.each(['account', 'amount', 'timestamp', 'business'] as const)('refuses a %s drift in otherwise SQL-issued effects', async kind => {
    const f = await h.fixture(), r = await h.captureRevisions(f), before = await h.captureState(f);
    await raw('ledger_transactions', async () => raw('ledger_entries', async () => {
      await expect(h.worker.sql.begin(async tx => {
        await h.prepareCapture(tx, r); const plan = (await h.readCapture(tx))[0].plan;
        const header = plan.effect_manifest.find(e => e.table === 'ledger_transactions' && e.write === 'INSERT')!;
        if (kind === 'business') { await insert(tx, 'ledger_transactions', { ...header.after, business_type: 'REFUND' }); return; }
        await insert(tx, 'ledger_transactions', header.after);
        const entry = plan.effect_manifest.find(e => e.table === 'ledger_entries')!, row = { ...entry.after };
        if (kind === 'account') row.account_id = plan.source_manifest.accounts.find(a => a.row.id !== row.account_id)!.row.id;
        else if (kind === 'amount') row.debit = Number(row.debit) + 1;
        else row.created_at = '2000-01-01T00:00:00.123456+00:00';
        await insert(tx, 'ledger_entries', row);
      })).rejects.toThrow();
    })); expect(await h.captureState(f)).toEqual(before);
  });
  it.each(['extra-entry', 'duplicate-entry', 'unmanifested-draft-touch'] as const)('refuses %s under a valid capture permit', async kind => {
    const f = await h.fixture(), r = await h.captureRevisions(f), before = await h.captureState(f);
    await raw('ledger_transactions', async () => raw('ledger_entries', async () => {
      await expect(h.worker.sql.begin(async tx => {
        await h.prepareCapture(tx, r); const plan = (await h.readCapture(tx))[0].plan;
        const header = plan.effect_manifest.find(e => e.table === 'ledger_transactions' && e.write === 'INSERT')!;
        await insert(tx, 'ledger_transactions', header.after);
        if (kind === 'unmanifested-draft-touch') await tx`update ledger_transactions set description=description||' changed' where id=${header.id}`;
        else {
          const entry = plan.effect_manifest.find(e => e.table === 'ledger_entries')!; await insert(tx, 'ledger_entries', entry.after);
          await insert(tx, 'ledger_entries', kind === 'extra-entry' ? { ...entry.after, id: h.randomUUID() } : entry.after);
        }
      })).rejects.toThrow();
    })); expect(await h.captureState(f)).toEqual(before);
  });
  it('rootless balanced capture effects cannot conceal an enrolled attempt behind another owner', async () => {
    const f = await h.fixture(), other = await h.fixture(), before = await h.captureState(f);
    await raw('ledger_transactions', async () => {
      await expect(h.worker.sql`insert into ledger_transactions(merchant_id,business_type,business_id,currency,description)
        values(${other.merchantId},'CAPTURE',${f.accepted.body.attemptId},${f.currency},'Rootless protected capture probe')`).rejects.toThrow();
    }); expect(await h.captureState(f)).toEqual(before);
  });
  it.each(['capture_preparation_issuances', 'financial_application_roots', 'financial_application_manifests', 'financial_application_permits'])
    ('the %s deferred backstop independently rejects a zero-effect issuance', async selected => {
      const f = await h.fixture(), r = await h.captureRevisions(f), before = await h.captureState(f);
      const others = ['capture_preparation_issuances', 'financial_application_roots', 'financial_application_manifests', 'financial_application_permits'].filter(t => t !== selected);
      for (const table of others) await h.db.sql.unsafe(`alter table public.${table} disable trigger capture_preparation_complete`);
      try { await expect(h.worker.sql.begin(tx => h.prepareCapture(tx, r))).rejects.toThrow(); }
      finally { for (const table of others) await h.db.sql.unsafe(`alter table public.${table} enable trigger capture_preparation_complete`); }
      expect(await h.captureState(f)).toEqual(before);
    });
  it.each(['payments', 'payment_attempts', 'ledger_transactions', 'audit_logs', 'webhook_events'])
    ('the %s deferred effect backstop discovers ownership with the whole authority group absent', async table => {
      const f = await h.fixture(), plan = await h.inspectPlan(f), before = await h.captureState(f);
      const effect = plan.effect_manifest.find(e => e.table === table && (table !== 'ledger_transactions' || e.write === 'INSERT'))!;
      // Administrator-only corruption probe; rollback restores the disabled immediate guards.
      const guards = await h.db.sql<{ tgname: string }[]>`select tgname from pg_trigger where tgrelid=${'public.' + table}::regclass
        and not tgisinternal and not tgdeferrable and (tgtype&2)=2 order by tgname`;
      let deferredReached = false;
      try { await expect(h.db.transaction(async tx => {
        for (const guard of guards) await tx.unsafe(`alter table public.${table} disable trigger "${guard.tgname}"`);
        if (effect.write === 'INSERT') await insert(tx, table, effect.after);
        else {
          const columns = Object.keys(effect.after).filter(column => column !== 'id');
          await tx.unsafe(`update public.${table} set ${columns.map(column => `"${column}"=(jsonb_populate_record(null::public.${table},$2::text::jsonb))."${column}"`).join(',')} where id=$1`,
            [effect.id, JSON.stringify(effect.after)]);
        }
        deferredReached = true;
        await tx.unsafe(`set constraints ${table === 'audit_logs' || table === 'webhook_events' ? 'capture_application_complete' : 'application_effect_complete'} immediate`);
      })).rejects.toThrow(/capture|manifest|protected|application permit|returned no rows/i); }
      finally { for (const guard of guards) await h.db.sql.unsafe(`alter table public.${table} enable trigger "${guard.tgname}"`); }
      expect(deferredReached).toBe(true);
      expect(await h.captureState(f)).toEqual(before);
    });
  async function fixtureTrigger(table: string, body: string, action: () => Promise<unknown>) {
    await h.db.sql.unsafe(`create function public.b2b_fixture_probe() returns trigger language plpgsql as $$ begin ${body} return NEW; end $$`);
    try {
      await h.db.sql.unsafe(`create trigger zz_b2b_fixture_probe before insert or update on public.${table} for each row execute function public.b2b_fixture_probe()`);
      await action();
    } finally {
      await h.db.sql.unsafe(`drop trigger if exists zz_b2b_fixture_probe on public.${table}`);
      await h.db.sql`drop function public.b2b_fixture_probe()`;
    }
  }
  it.each(['ledger_transactions', 'ledger_entries', 'payment_attempts', 'payments', 'capture_accounting_lots', 'audit_logs',
    'financial_applications', 'financial_application_dispositions', 'financial_application_effect_links', 'financial_application_revision_effects', 'webhook_events'])
    ('omitting the entire %s write group cannot commit', async table => {
      const f = await h.fixture(), before = await h.captureState(f);
      await fixtureTrigger(table, 'return NULL;', async () => { await expect(h.completeCapture(f)).rejects.toThrow(); });
      expect(await h.captureState(f)).toEqual(before);
    });
  it.each(['ledger_accounts', 'ledger_transactions', 'ledger_entries', 'payment_attempts', 'payments', 'capture_accounting_lots', 'audit_logs',
    'financial_application_effect_links', 'financial_application_dispositions', 'financial_application_revision_effects'])
    ('a failure after the %s phase rolls back all writes but retains committed evidence', async table => {
      const f = await h.fixture(), before = await h.captureState(f);
      const body = table === 'ledger_accounts' ? `if NEW.merchant_id is not null then raise exception 'planned capture phase failure'; end if;`
        : table === 'ledger_transactions' ? `if NEW.status='POSTED' then raise exception 'planned capture phase failure'; end if;`
        : `raise exception 'planned capture phase failure';`;
      await fixtureTrigger(table, body, async () => { await expect(h.completeCapture(f)).rejects.toThrow(/planned capture phase failure/); });
      expect(await h.captureState(f)).toEqual(before);
      expect(await h.evidence.read(f.capture.inboxId, 'payment.capture_succeeded')).toMatchObject({ id: f.capture.proofId });
    });
  it('a successful SQL return stays provisional when a later deferred COMMIT check fails', async () => {
    const f = await h.fixture(), request = await h.captureRevisions(f), before = await h.captureState(f); let returned = false;
    await h.db.sql.unsafe(`create function public.b2b_fixture_commit_failure() returns trigger language plpgsql as $$
      begin raise exception 'planned capture COMMIT failure'; end $$`);
    try {
      await h.db.sql`create constraint trigger zz_b2b_fixture_commit_failure after insert on financial_application_revision_effects
        deferrable initially deferred for each row execute function public.b2b_fixture_commit_failure()`;
      await expect(h.worker.sql.begin(async tx => { await h.completeCaptureIn(tx, request); returned = true; })).rejects.toThrow(/planned capture COMMIT failure/);
      expect(returned).toBe(true); expect(await h.captureState(f)).toEqual(before);
      expect(await h.evidence.read(f.capture.inboxId, 'payment.capture_succeeded')).toMatchObject({ id: f.capture.proofId });
    } finally {
      await h.db.sql`drop trigger if exists zz_b2b_fixture_commit_failure on financial_application_revision_effects`;
      await h.db.sql`drop function public.b2b_fixture_commit_failure()`;
    }
  });
  it.each(['payments', 'payment_attempts', 'ledger_accounts', 'ledger_transactions', 'ledger_entries', 'capture_accounting_lots', 'audit_logs', 'webhook_events',
    'capture_preparation_issuances', 'financial_application_roots', 'financial_application_manifests', 'financial_application_permits',
    'financial_applications', 'financial_application_dispositions', 'financial_application_revision_effects', 'financial_application_effect_links',
    'financial_application_contracts', 'financial_application_scope_authority'])
    ('an ordinary restricted LOGIN has no %s write capability', async table => {
      const [rights] = await h.db.sql`select has_table_privilege(${h.ordinary.role},${'public.' + table},'INSERT,UPDATE,DELETE,TRUNCATE') writes`;
      expect(rights.writes).toBe(false);
      await expect(h.ordinary.sql.unsafe(`insert into public.${table} default values`)).rejects.toMatchObject({ code: '42501' });
    });
  it('worker capability is EXECUTE only and temporary shadows cannot redirect protected capture SQL', async () => {
    const f = await h.fixture(), r = await h.captureRevisions(f);
    for (const table of ['ledger_accounts', 'ledger_transactions', 'ledger_entries', 'payments', 'payment_attempts', 'webhook_events']) {
      expect((await h.db.sql`select has_table_privilege(${h.worker.role},${'public.' + table},'INSERT,UPDATE,DELETE') writes`)[0].writes).toBe(false);
    }
    await h.worker.sql.begin(async tx => {
      await tx`create temporary table ledger_transactions(id uuid)`; await tx`create temporary table payments(id uuid)`;
      await tx`set local search_path=pg_temp,public`;
      await h.completeCaptureIn(tx, r);
      expect(await tx`select 1 from pg_temp.ledger_transactions`).toHaveLength(0); expect(await tx`select 1 from pg_temp.payments`).toHaveLength(0);
    }); expect(await h.captureState(f)).toMatchObject({ journals: 1, lots: 1, links: 2 });
  });
});
