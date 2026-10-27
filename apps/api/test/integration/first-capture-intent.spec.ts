import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ObservationTransactions } from '../../src/payment-provider/provider-observation-database';
import { firstCaptureIntentHarness, type IntentRequest, type IntentVariant } from '../support/first-capture-intent-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30000);
describeDb('P-C protected first capture intent', () => {
  let h: Awaited<ReturnType<typeof firstCaptureIntentHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  beforeAll(async () => { h = await firstCaptureIntentHarness(); await h.install(); }, 30000);
  afterAll(async () => { if (h) await h.close(); });

  async function state(f: Fixture) {
    const [row] = await h.db.sql`select
      (select to_jsonb(p) from payments p where id=${f.paymentId}) payment,
      (select jsonb_agg(to_jsonb(t) order by id) from payment_attempts t where payment_id=${f.paymentId}) attempts,
      (select jsonb_agg(to_jsonb(t) order by id) from outbox_events t where payload->>'paymentId'=${f.paymentId}) outboxes,
      (select jsonb_agg(to_jsonb(t) order by outbox_id) from provider_command_authorities t where payment_id=${f.paymentId}) commands,
      (select jsonb_agg(to_jsonb(t) order by id) from first_capture_intent_requests t where payment_id=${f.paymentId}) requests,
      (select jsonb_agg(to_jsonb(t) order by id) from first_capture_intent_manifests t where payment_id=${f.paymentId}) manifests,
      (select jsonb_agg(to_jsonb(t) order by manifest_id) from first_capture_intent_acceptances t where payment_id=${f.paymentId}) acceptances,
      (select jsonb_agg(to_jsonb(t) order by transaction_id) from financial_application_permits t where
        manifest_id in(select id from financial_application_manifests where payment_id=${f.paymentId}) or
        intent_manifest_id in(select id from first_capture_intent_manifests where payment_id=${f.paymentId})) permits,
      (select jsonb_agg(to_jsonb(t) order by id) from audit_logs t where target_id=${f.paymentId}) audits,
      (select to_jsonb(s) from capture_accounting_scopes s where merchant_id=${f.merchantId} and currency=${f.currency}) scope,
      (select to_jsonb(w) from webhook_events w where id=${f.inboxId}) auth_inbox,
      (select count(*)::int from ledger_transactions where merchant_id=${f.merchantId}) journals,
      (select count(*)::int from capture_accounting_lots where payment_id=${f.paymentId}) lots,
      (select count(*)::int from financial_applications a join financial_application_roots r on r.id=a.root_id where r.payment_id=${f.paymentId}) applications,
      (select count(*)::int from financial_application_dispositions d join financial_application_roots r on r.id=d.root_id where r.payment_id=${f.paymentId}) dispositions`;
    return row;
  }
  async function refused(f: Fixture, request: IntentRequest) {
    const before = await state(f);
    await expect(h.accept(request)).rejects.toMatchObject({ code: expect.any(String) as string });
    expect(await state(f)).toEqual(before);
  }
  async function waitFor(blocker: number, waiter: number) {
    expect(waiter).not.toBe(blocker);
    for (let i = 0; i < 150; i++) {
      if ((await h.db.sql`select ${blocker}=any(pg_blocking_pids(${waiter})) blocked`)[0].blocked) return;
      await delay(20);
    }
    throw new Error('P-C expected lock wait was not observed');
  }
  const variants: [IntentVariant, number, boolean][] = [['FULL', 10000, true], ['FIRST_PARTIAL', 4000, false], ['FINAL_PARTIAL', 4000, true]];
  it.each(variants)('commits genuine %s intent and independently signed D02/B1 proof without capture effects', async (variant, amount, final) => {
    const f = await h.fixture(), request = await h.request(f, variant, amount), before = await state(f);
    const [accepted] = await h.worker.sql.begin(async tx => {
      await h.prepareIntent(tx, request); const result = await h.applyIntent(tx); await tx`set constraints all immediate`; return result;
    });
    expect(accepted.result).toEqual({ statusCode: 202, body: { paymentId: f.paymentId, attemptId: expect.any(String) as string, status: 'CAPTURE_PENDING', amount } });
    const after = await state(f);
    expect(after.payment).toMatchObject({ status: 'CAPTURE_PENDING', amount: f.amount, authorized_amount: f.amount,
      captured_amount: 0, platform_fee_amount: 0, refunded_amount: 0, version: request.version + 1 });
    expect(after).toMatchObject({ journals: 0, lots: 0, applications: 1, dispositions: 2 });
    expect(after.auth_inbox).toEqual(before.auth_inbox);
    const [child] = await h.db.sql`select * from payment_attempts where id=${accepted.result.body.attemptId}`;
    expect(child).toMatchObject({ merchant_id: f.merchantId, payment_id: f.paymentId, kind: 'CAPTURE', status: 'PENDING', amount: String(amount), currency: f.currency });
    const [command] = await h.db.sql<{ command_key: string; command_payload: unknown }[]>`select * from provider_command_authorities where operation_id=${accepted.result.body.attemptId}`;
    expect(command).toMatchObject({ operation: 'CAPTURE', amount: String(amount), provider_account: f.account, provider_mode: 'TEST',
      accounting_policy: 'LEGACY', acceptance_epoch: '0', command_key: `capture:${accepted.result.body.attemptId}` });
    expect(command.command_payload).toEqual({ merchantId: f.merchantId, paymentId: f.paymentId, attemptId: accepted.result.body.attemptId,
      amount, currency: f.currency, providerPaymentId: f.pi, finalCapture: final, idempotencyKey: command.command_key });
    expect(command.command_key).not.toBe(request.key);
    for (const table of ['first_capture_intent_requests', 'first_capture_intent_manifests', 'first_capture_intent_acceptances'])
      expect(await h.db.sql`select 1 from ${h.db.sql(table)} where payment_id=${f.paymentId}`).toHaveLength(1);
    expect(await h.db.sql`select 1 from audit_logs where target_id=${f.paymentId} and action='payment.capture_requested'`).toHaveLength(1);
    expect((await h.db.sql`select prior_revision::text prior,final_revision::text final from first_capture_intent_acceptances where payment_id=${f.paymentId}`)[0])
      .toEqual({ prior: request.scope, final: String(BigInt(request.scope) + 1n) });
    const evidence = await h.captureEvidence(f, accepted.result);
    expect(evidence.transport.calls).toHaveLength(1);
    const proof = await h.evidence.read(evidence.inboxId, 'payment.capture_succeeded');
    expect(proof).toMatchObject({ id: evidence.proofId, source_id: evidence.sourceId, authorization_source_id: f.sourceId,
      capture_principal: String(amount), authorized_principal: null,
      facts: { authorized_capacity: f.amount, final_capture: final } });
    expect((await h.db.sql`select disposition from receipt_admission_obligations where inbox_id=${evidence.inboxId}`)[0].disposition).toBe('AWAITING_APPLICATION');
    expect((await h.db.sql`select disposition,reason from provider_observation_obligations where source_id=${evidence.sourceId}`)[0])
      .toEqual({ disposition: 'BLOCKING_REVIEW', reason: 'CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED' });
    await expect(h.inspect(f)).rejects.toThrow();
    expect(await state(f)).toMatchObject({ journals: 0, lots: 0, applications: 1, dispositions: 2 });
  });
  it.each([1, Number.MAX_SAFE_INTEGER])('accepts the exact full amount boundary %s', async amount => {
    const f = await h.fixture({ amount }), request = await h.request(f);
    expect((await h.accept(request))[0].result.body.amount).toBe(amount);
  });
  it('retains EUR ownership through genuine first partial B1 evidence', async () => {
    const f = await h.fixture({ currency: 'EUR', amount: 2 }), request = await h.request(f, 'FIRST_PARTIAL', 1), [accepted] = await h.accept(request);
    const e = await h.captureEvidence(f, accepted.result);
    expect(await h.evidence.read(e.inboxId, 'payment.capture_succeeded')).toMatchObject({ currency: 'EUR', capture_principal: '1', authorized_principal: null,
      facts: { authorized_capacity: 2 } });
  });
  it.each(['0', '-1', '10001', '1.5', 'NaN', 'Infinity', '-Infinity', '9007199254740992'])('rejects invalid bounded integer gross %s atomically', async amount => {
    const f = await h.fixture(), r = await h.request(f); await refused(f, { ...r, amount });
  });
  it.each([['FULL', 1], ['FIRST_PARTIAL', 10000], ['FINAL_PARTIAL', 10000], ['UNKNOWN', 10000]] as const)
    ('refuses incompatible variant %s and amount %s', async (variant, amount) => {
      const f = await h.fixture(), r = await h.request(f); await refused(f, { ...r, variant, amount });
    });
  it.each(['version', 'scope', 'intake'] as const)('refuses stale expected %s without a request record', async key => {
    const f = await h.fixture(), r = await h.request(f); await refused(f, { ...r, [key]: key === 'version' ? -1 : '-1' });
  });
  it.each(['missing', 'proof', 'attempt'] as const)('a %s UUID cannot replace completed P-B authority', async kind => {
    const f = await h.fixture(), r = await h.request(f);
    await refused(f, { ...r, rootId: kind === 'missing' ? randomUUID() : kind === 'proof' ? f.proofId : f.attemptId });
  });
  it('a canonical AUTH root without a completed P-B application cannot authorize capture', async () => {
    const original = await h.authorizationFixture({ enroll: false }), rootId = randomUUID();
    await h.db.sql`insert into financial_application_roots(id,family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,attempt_id)
      values(${rootId},'AUTHORIZE',${original.attemptId},'TERMINAL',${original.merchantId},${original.currency},'STRIPE',${original.account},'LEGACY',0,${original.outboxId},${original.paymentId},${original.attemptId})`;
    await original.enroll(); const f = { ...original, rootId }; await refused(f, await h.request(f));
  });
  it.each(['', 'x'.repeat(256)])('refuses a private request key outside its bounds (%s)', async key => {
    const f = await h.fixture(); await refused(f, { ...await h.request(f), key });
  });
  it('same-key committed replay preserves its result and all owned rows', async () => {
    const f = await h.fixture(), r = await h.request(f), first = await h.accept(r), before = await state(f);
    expect(await h.accept({ ...r, version: -1, scope: '-1', intake: '-1' })).toEqual(first);
    expect(await state(f)).toEqual(before);
    expect((await h.recognize(f))[0].id).toBe(f.rootId);
    expect(await state(f)).toEqual(before);
  });
  it.each(['amount', 'variant'] as const)('same-key changed %s refuses without changing the accepted group', async key => {
    const f = await h.fixture(), r = await h.request(f, 'FIRST_PARTIAL', 4000); await h.accept(r);
    await refused(f, { ...r, [key]: key === 'amount' ? 5000 : 'FINAL_PARTIAL' });
  });
  it('a second distinct key cannot accept another first or later pending capture', async () => {
    const f = await h.fixture(), r = await h.request(f, 'FIRST_PARTIAL', 4000); await h.accept(r);
    await refused(f, { ...r, key: randomUUID() });
  });
  it('a distinct session principal cannot replay another principal request', async () => {
    const f = await h.fixture(), r = await h.request(f); await h.accept(r); const before = await state(f), other = await h.login('pc_other');
    await h.db.sql.unsafe(`grant execute on function public.accept_first_capture_intent(uuid,text,numeric,text,integer,bigint,bigint) to "${other.role}"`);
    await expect(h.accept(r, other.sql)).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it('replays immutable command identity after real D02/B1 publication and outbox delivery changes', async () => {
    const f = await h.fixture(), r = await h.request(f), first = await h.accept(r), e = await h.captureEvidence(f, first[0].result);
    await h.db.sql`update outbox_events set status='PUBLISHED',attempts=attempts+1,published_at=now(),locked_at=null where id=${e.outbox.id}`;
    const before = await state(f); expect(await h.accept(r)).toEqual(first); expect(await state(f)).toEqual(before);
    expect((await h.recognize(f))[0].id).toBe(f.rootId); expect(await state(f)).toEqual(before);
  });
  it('retains original AUTH outbox delivery bookkeeping after capture intent', async () => {
    const f = await h.fixture(), r = await h.request(f), first = await h.accept(r);
    await h.db.sql`update outbox_events set status='PUBLISHED',attempts=attempts+1,published_at=now(),locked_at=null where id=${f.outboxId}`;
    const before = await state(f); expect(await h.accept(r)).toEqual(first);
    expect((await h.recognize(f))[0].id).toBe(f.rootId); expect(await state(f)).toEqual(before);
  });
  it('a newly published original AUTH result remains blocking without rewriting completed AUTH history', async () => {
    const f = await h.fixture(), r = await h.request(f); await (await f.exchange()).publish();
    await refused(f, r); expect((await h.recognize(f))[0].id).toBe(f.rootId);
  });
  it('an OPEN scoped exception remains an independent blocker', async () => {
    const f = await h.fixture(), r = await h.request(f);
    await h.db.sql`insert into accounting_exceptions(merchant_id,currency,payment_id,category,source_kind,evidence_key,observed_conflict)
      values(${f.merchantId},${f.currency},${f.paymentId},'AMBIGUOUS_PROVIDER_NET_EFFECT','INTERNAL',${`pc:${randomUUID()}`},'{}')`;
    await refused(f, r);
  });
  it.each(['audit-target', 'audit-attempt', 'audit-outbox', 'outbox-payment', 'outbox-uppercase-payment', 'outbox-attempt'] as const)
    ('refuses earlier owned %s evidence without changing genuine P-B history', async kind => {
      const original = await h.authorizationFixture({ enroll: false });
      const table = kind.startsWith('audit') ? 'audit_logs' : 'outbox_events';
      let extraId: string;
      if (table === 'audit_logs') {
        extraId = randomUUID();
        const metadata: Record<string, string> = kind === 'audit-attempt' ? { attemptId: original.attemptId.toUpperCase() }
          : kind === 'audit-outbox' ? { outboxId: original.outboxId.toUpperCase() } : {};
        const target = kind === 'audit-target' ? original.paymentId.toUpperCase() : randomUUID();
        await h.initial.sql`insert into audit_logs(id,merchant_id,actor_type,action,target_type,target_id,metadata)
          values(${extraId},${original.merchantId},'SYSTEM','payment.capture_requested','payment',${target},${h.initial.sql.json(metadata)})`;
      } else {
        const payload: Record<string, string> = kind === 'outbox-payment' ? { paymentId: original.paymentId }
          : kind === 'outbox-uppercase-payment' ? { paymentId: original.paymentId.toUpperCase() } : { attemptId: original.attemptId.toUpperCase() };
        const [extra] = await h.initial.sql<{ id: string }[]>`insert into outbox_events(aggregate_type,aggregate_id,event_type,payload)
          values('PAYMENT_ATTEMPT',${randomUUID()},'provider.capture.requested',${h.initial.sql.json(payload)}) returning id`;
        extraId = extra.id;
      }
      await original.enroll(); const [completed] = await h.complete(original), f = { ...original, rootId: completed.id };
      expect((await h.recognize(f))[0].id).toBe(f.rootId);
      const before = await state(f), extra = await h.db.sql`select to_jsonb(t) body from ${h.db.sql(table)} t where id=${extraId}`;
      expect(extra).toHaveLength(1);
      await expect(h.accept(await h.request(f))).rejects.toThrow(/Exact first MANUAL capture/);
      expect(await state(f)).toEqual(before);
      expect(await h.db.sql`select to_jsonb(t) body from ${h.db.sql(table)} t where id=${extraId}`).toEqual(extra);
      expect((await h.recognize(f))[0].id).toBe(f.rootId);
    });
  it.each([false, true])('raw audit ownership follows the accepted outbox link (uppercase=%s)', async uppercase => {
    const f = await h.fixture(), r = await h.request(f), [accepted] = await h.accept(r), before = await state(f), extraId = randomUUID();
    const [outbox] = await h.db.sql<{ id: string }[]>`select id from outbox_events where aggregate_id=${accepted.result.body.attemptId}`;
    const metadata = { outboxId: uppercase ? outbox.id.toUpperCase() : outbox.id };
    await expect(h.initial.sql`insert into audit_logs(id,merchant_id,actor_type,action,target_type,target_id,metadata)
      values(${extraId},null,'SYSTEM','payment.capture_requested','payment',${randomUUID()},${h.initial.sql.json(metadata)})`).rejects.toThrow(/capture intent permit/);
    expect(await state(f)).toEqual(before);
    expect(await h.db.sql`select 1 from audit_logs where id=${extraId}`).toHaveLength(0);
  });
  it.each(['audit_logs', 'outbox_events'] as const)('deferred closure rejects an extra owned %s independently of its immediate guard', async table => {
    const f = await h.fixture(), r = await h.request(f), before = await state(f), extraId = randomUUID();
    // Fault injection isolates final closure from the immediate guard; only this disposable database is affected.
    await h.db.sql.unsafe(`alter table public.${table} disable trigger first_capture_intent_write`);
    try {
      await expect(h.db.sql.begin(async tx => {
        await h.acceptIn(tx, r);
        if (table === 'audit_logs') await tx`insert into audit_logs(id,merchant_id,actor_type,action,target_type,target_id)
          values(${extraId},${f.merchantId},'SYSTEM','payment.capture_requested','payment',${f.paymentId.toUpperCase()})`;
        else await tx`insert into outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
          values(${extraId},'PAYMENT_ATTEMPT',${randomUUID()},'provider.capture.requested',${tx.json({ paymentId: f.paymentId.toUpperCase() })})`;
        await tx`set constraints all immediate`;
      })).rejects.toThrow(/Capture intent requires exact workflow groups/);
      expect(await state(f)).toEqual(before);
      expect(await h.db.sql`select 1 from ${h.db.sql(table)} where id=${extraId}`).toHaveLength(0);
    } finally { await h.db.sql.unsafe(`alter table public.${table} enable trigger first_capture_intent_write`); }
  });
  it('prepare-only COMMIT and early immediate constraints refuse incomplete intent', async () => {
    for (const immediate of [false, true]) {
      const f = await h.fixture(), r = await h.request(f), before = await state(f);
      await expect(h.worker.sql.begin(async tx => { await h.prepareIntent(tx, r); if (immediate) await tx`set constraints all immediate`; })).rejects.toThrow();
      expect(await state(f)).toEqual(before);
    }
  });
  it('rollback after complete immediate validation leaves no intent or command', async () => {
    const f = await h.fixture(), r = await h.request(f), before = await state(f);
    await expect(h.worker.sql.begin(async tx => { await h.prepareIntent(tx, r); await h.applyIntent(tx); await tx`set constraints all immediate`; throw new Error('P-C late rollback'); })).rejects.toThrow('P-C late rollback');
    expect(await state(f)).toEqual(before); await h.accept(r);
  });
  it('savepoint rollback removes its permit and subtransaction construction cannot weaken D02 xmin', async () => {
    const f = await h.fixture(), r = await h.request(f);
    // Direct control isolates PostgreSQL recovery from postgres.js begin's sticky query-error bookkeeping.
    const tx = await h.worker.sql.reserve();
    const prepare = () => tx`select public.prepare_first_capture_intent(${r.rootId},${r.key},${r.amount}::numeric,${r.variant},${r.version},${r.scope},${r.intake})`;
    try {
      await tx`begin`; await tx`savepoint pc_prepared`; await prepare();
      await tx`rollback to savepoint pc_prepared`; await tx`release savepoint pc_prepared`;
      await tx`savepoint pc_missing`;
      await expect(tx`select public.apply_first_capture_intent()`).rejects.toThrow(/capture intent permit/);
      await tx`rollback to savepoint pc_missing`; await tx`release savepoint pc_missing`;
      await tx`savepoint pc_xmin`; await prepare();
      await expect(tx`select public.apply_first_capture_intent()`).rejects.toThrow(/Only prospective same-transaction/);
      await tx`rollback to savepoint pc_xmin`; await tx`release savepoint pc_xmin`;
      await prepare(); await tx`select public.apply_first_capture_intent()`; await tx`commit`;
    } catch (error) { await tx`rollback`; throw error; } finally { tx.release(); }
    expect(await state(f)).toMatchObject({ journals: 0, lots: 0, applications: 1 });
  });
  it('another backend and later transaction cannot borrow an intent permit', async () => {
    const f = await h.fixture(), r = await h.request(f);
    await h.worker.sql.begin(async tx => { await h.prepareIntent(tx, r); await expect(h.peer`select public.apply_first_capture_intent()`).rejects.toThrow(); await h.applyIntent(tx); });
    await expect(h.worker.sql`select public.apply_first_capture_intent()`).rejects.toThrow();
  });
  it('one top-level transaction cannot hold two intent permits', async () => {
    const f = await h.fixture(), g = await h.fixture(), a = await h.request(f), b = await h.request(g), before = await state(f), other = await state(g);
    await expect(h.worker.sql.begin(async tx => { await h.prepareIntent(tx, a); await h.prepareIntent(tx, b); })).rejects.toThrow();
    expect(await state(f)).toEqual(before); expect(await state(g)).toEqual(other);
  });
  it('APPLICATION and CAPTURE_INTENT cannot authorize one another or coexist', async () => {
    const f = await h.fixture(), r = await h.request(f), before = await state(f);
    await expect(h.worker.sql.begin(async tx => { await h.prepareIntent(tx, r); await h.apply(tx); })).rejects.toThrow();
    expect(await state(f)).toEqual(before);
    await expect(h.worker.sql.begin(async tx => { await h.prepareIntent(tx, r); await tx`select public.current_financial_application_manifest()`; })).rejects.toThrow();
    expect(await state(f)).toEqual(before);
    const g = await h.authorizationFixture(), generation = await h.claim(g), rev = await h.revisions(g);
    await expect(h.worker.sql.begin(async tx => { await h.prepare(tx, g, generation!, rev); await h.applyIntent(tx); })).rejects.toThrow();
    await expect(h.worker.sql.begin(async tx => { await h.prepare(tx, g, generation!, rev); await h.prepareIntent(tx, r); })).rejects.toThrow();
    expect(await state(f)).toEqual(before);
  });
  it.each(['amount', 'PI', 'finality', 'key'] as const)('accepted command %s cannot be rewritten', async field => {
    const f = await h.fixture(), r = await h.request(f), [accepted] = await h.accept(r), before = await state(f);
    const [outbox] = await h.db.sql<{ id: string; payload: Record<string, unknown> }[]>`select id,payload from outbox_events where aggregate_id=${accepted.result.body.attemptId}`;
    const payload = { ...outbox.payload, ...(field === 'amount' ? { amount: 1 } : field === 'PI' ? { providerPaymentId: 'pi_foreign' }
      : field === 'finality' ? { finalCapture: false } : { idempotencyKey: 'capture:forged' }) };
    await expect(h.db.sql`update outbox_events set payload=${h.db.sql.json(payload as never)} where id=${outbox.id}`).rejects.toThrow();
    await expect(h.db.sql`update provider_command_authorities set command_payload=${h.db.sql.json(payload as never)} where outbox_id=${outbox.id}`).rejects.toThrow();
    expect(await state(f)).toEqual(before);
  });
  it('an intent permit cannot post money or add an unplanned capture child', async () => {
    const f = await h.fixture(), r = await h.request(f), before = await state(f), attacker = await h.login('pc_extra');
    await h.db.sql.unsafe(`grant execute on function public.prepare_first_capture_intent(uuid,text,numeric,text,integer,bigint,bigint) to "${attacker.role}"`);
    await h.db.sql.unsafe(`grant insert(merchant_id,business_type,business_id,currency,description) on ledger_transactions to "${attacker.role}"`);
    await h.db.sql.unsafe(`grant insert(id,merchant_id,payment_id,kind,amount,currency) on payment_attempts to "${attacker.role}"`);
    await expect(attacker.sql.begin(async tx => {
      await h.prepareIntent(tx, r); await tx`insert into ledger_transactions(merchant_id,business_type,business_id,currency,description)
        values(${f.merchantId},'CAPTURE',${randomUUID()},${f.currency},'P-C forbidden money')`;
    })).rejects.toThrow();
    await expect(attacker.sql.begin(async tx => {
      await h.prepareIntent(tx, r); await tx`insert into payment_attempts(id,merchant_id,payment_id,kind,amount,currency)
        values(${randomUUID()},${f.merchantId},${f.paymentId},'CAPTURE',10000,${f.currency})`;
    })).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it('forged JSON/GUC authority cannot apply an intent', async () => {
    await expect(h.worker.sql.begin(async tx => { await tx`select set_config('app.financial_permit',${JSON.stringify({ permit_kind: 'CAPTURE_INTENT', intent_manifest_id: randomUUID() })},true)`; await h.applyIntent(tx); })).rejects.toThrow();
  });
  it('raw permit INSERT privilege cannot reuse a genuine historical intent manifest', async () => {
    const f = await h.fixture(), r = await h.request(f); await h.accept(r);
    const [manifest] = await h.db.sql<{ id: string }[]>`select id from first_capture_intent_manifests where payment_id=${f.paymentId}`;
    const attacker = await h.login('pc_permit'), before = await state(f);
    await h.db.sql.unsafe(`grant insert on financial_application_permits to "${attacker.role}"`);
    await expect(attacker.sql`insert into financial_application_permits(transaction_id,backend_pid,database_principal,permit_kind,intent_manifest_id)
      values(pg_current_xact_id(),pg_backend_pid(),session_user,'CAPTURE_INTENT',${manifest.id})`).rejects.toThrow();
    expect(await state(f)).toEqual(before);
  });
  it('uppercase UUIDs cannot hide protected outbox ownership from raw column guards', async () => {
    const f = await h.fixture(), attacker = await h.login('pc_outbox_case'), outboxId = randomUUID();
    await h.db.sql.unsafe(`grant insert(id,aggregate_type,aggregate_id,event_type,payload) on outbox_events to "${attacker.role}"`);
    await expect(attacker.sql`insert into outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
      values(${outboxId},'PAYMENT_ATTEMPT',${randomUUID()},'provider.capture.requested',${attacker.sql.json({ paymentId: f.paymentId.toUpperCase(), attemptId: randomUUID() })})`).rejects.toThrow();
    expect(await h.db.sql`select 1 from outbox_events where id=${outboxId}`).toHaveLength(0);
  });
  it('uppercase intent linkage cannot hide an extra audit behind a different action', async () => {
    const f = await h.fixture(); await h.accept(await h.request(f));
    const [manifest] = await h.db.sql<{ id: string }[]>`select id from first_capture_intent_manifests where payment_id=${f.paymentId}`;
    const attacker = await h.login('pc_audit_case'), auditId = randomUUID();
    await h.db.sql.unsafe(`grant insert on audit_logs to "${attacker.role}"`);
    await expect(attacker.sql`insert into audit_logs(id,merchant_id,actor_type,action,target_type,target_id,metadata)
      values(${auditId},null,'SYSTEM','unrelated.note','other',${randomUUID()},${attacker.sql.json({ intentId: manifest.id.toUpperCase() })})`).rejects.toThrow();
    expect(await h.db.sql`select 1 from audit_logs where id=${auditId}`).toHaveLength(0);
  });
  it.each(['first_capture_intent_requests', 'first_capture_intent_manifests', 'first_capture_intent_acceptances', 'financial_application_permits',
    'payment_attempts', 'outbox_events', 'provider_command_authorities', 'audit_logs', 'ledger_transactions'])('worker cannot directly INSERT %s', async table => {
    await expect(h.worker.sql.unsafe(`insert into public.${table} default values`)).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['prepare', 'apply', 'accept'] as const)('ordinary LOGIN has no private %s capability', async operation => {
    const f = await h.fixture(), r = await h.request(f);
    const work = h.ordinary.sql.begin(async tx => {
      if (operation === 'apply') await h.applyIntent(tx);
      else if (operation === 'prepare') await h.prepareIntent(tx, r);
      else await h.acceptIn(tx, r);
    });
    await expect(work).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['first_capture_intent_requests', 'first_capture_intent_manifests', 'first_capture_intent_acceptances'] as const)
    ('accepted %s rows reject UPDATE, DELETE and TRUNCATE', async table => {
      const f = await h.fixture(), r = await h.request(f); await h.accept(r); const before = await state(f);
      await expect(h.db.sql`update ${h.db.sql(table)} set payment_id=payment_id where payment_id=${f.paymentId}`).rejects.toThrow();
      await expect(h.db.sql`delete from ${h.db.sql(table)} where payment_id=${f.paymentId}`).rejects.toThrow();
      await expect(h.db.sql.unsafe(`truncate public.${table} cascade`)).rejects.toThrow(); expect(await state(f)).toEqual(before);
    });
  it.each(['payments', 'payment_attempts', 'outbox_events', 'audit_logs'] as const)('extra column grants cannot forge P-owned %s', async table => {
    const f = await h.fixture(), before = await state(f), attacker = await h.login('pc_column');
    if (table === 'payments') {
      await h.db.sql.unsafe(`grant update(status,version),select(id,version) on payments to "${attacker.role}"`);
      await expect(attacker.sql`update payments set status='CAPTURE_PENDING',version=version+1 where id=${f.paymentId}`).rejects.toThrow();
    } else if (table === 'payment_attempts') {
      await h.db.sql.unsafe(`grant insert(id,merchant_id,payment_id,kind,amount,currency) on payment_attempts to "${attacker.role}"`);
      await expect(attacker.sql`insert into payment_attempts(id,merchant_id,payment_id,kind,amount,currency) values(${randomUUID()},${f.merchantId},${f.paymentId},'CAPTURE',10000,${f.currency})`).rejects.toThrow();
    } else if (table === 'outbox_events') {
      await h.db.sql.unsafe(`grant insert(aggregate_type,aggregate_id,event_type,payload) on outbox_events to "${attacker.role}"`);
      await expect(attacker.sql`insert into outbox_events(aggregate_type,aggregate_id,event_type,payload) values('PAYMENT_ATTEMPT',${f.attemptId},'provider.capture.requested',${attacker.sql.json({ merchantId: f.merchantId, paymentId: f.paymentId, attemptId: f.attemptId })})`).rejects.toThrow();
    } else {
      await h.db.sql.unsafe(`grant insert on audit_logs to "${attacker.role}"`);
      await expect(attacker.sql`insert into audit_logs(merchant_id,actor_type,action,target_type,target_id) values(null,'SYSTEM','payment.capture_requested','payment',${f.paymentId})`).rejects.toThrow();
    }
    expect(await state(f)).toEqual(before);
  });

  const groups = [
    ['request', 'first_capture_intent_requests', 'INSERT', 'NEW.payment_id'],
    ['manifest', 'first_capture_intent_manifests', 'INSERT', 'NEW.payment_id'],
    ['permit', 'financial_application_permits', 'INSERT', '(select payment_id from public.first_capture_intent_manifests where id=NEW.intent_manifest_id)'],
    ['payment', 'payments', 'UPDATE', 'NEW.id'], ['attempt', 'payment_attempts', 'INSERT', 'NEW.payment_id'],
    ['outbox', 'outbox_events', 'INSERT', "(NEW.payload->>'paymentId')::uuid"],
    ['authority', 'provider_command_authorities', 'INSERT', 'NEW.payment_id'],
    ['audit', 'audit_logs', 'INSERT', 'NEW.target_id::uuid'],
    ['acceptance', 'first_capture_intent_acceptances', 'INSERT', 'NEW.payment_id'],
    ['revision', 'capture_accounting_scopes', 'UPDATE', 'NEW.merchant_id'],
  ] as const;
  it.each(groups)('omitting the entire %s group cannot commit partial intent', async (group, table, event, selector) => {
    const f = await h.fixture(), r = await h.request(f), before = await state(f), target = group === 'revision' ? f.merchantId : f.paymentId;
    await h.db.sql.unsafe(`create function public.pc_test_fault() returns trigger language plpgsql as $body$ begin if ${selector}='${target}'::uuid then ${event === 'UPDATE' ? 'return OLD' : 'return NULL'}; end if; return NEW; end $body$`);
    await h.db.sql.unsafe(`create trigger zz_pc_test_fault before ${event} on public.${table} for each row execute function public.pc_test_fault()`);
    try { await expect(h.accept(r)).rejects.toThrow(); expect(await state(f)).toEqual(before); }
    finally { await h.db.sql.unsafe(`drop trigger zz_pc_test_fault on public.${table}`); await h.db.sql`drop function public.pc_test_fault()`; }
  });
  it.each(groups)('a fault after %s rolls back every P-C write', async (group, table, event, selector) => {
    const f = await h.fixture(), r = await h.request(f), before = await state(f), target = group === 'revision' ? f.merchantId : f.paymentId;
    await h.db.sql.unsafe(`create function public.pc_test_fault() returns trigger language plpgsql as $body$ begin if ${selector}='${target}'::uuid then raise exception 'P-C injected ${group} failure'; end if; return NEW; end $body$`);
    await h.db.sql.unsafe(`create trigger zz_pc_test_fault after ${event} on public.${table} for each row execute function public.pc_test_fault()`);
    try { await expect(h.accept(r)).rejects.toThrow(`P-C injected ${group} failure`); expect(await state(f)).toEqual(before); }
    finally { await h.db.sql.unsafe(`drop trigger zz_pc_test_fault on public.${table}`); await h.db.sql`drop function public.pc_test_fault()`; }
  });
  it.each(['same-key-exact', 'same-key-changed', 'distinct-key'] as const)('serializes real %s requests on distinct backends', async kind => {
    const f = await h.fixture(), a = await h.request(f, 'FIRST_PARTIAL', 4000), b = { ...a,
      ...(kind === 'same-key-changed' ? { amount: 5000 } : {}), ...(kind === 'distinct-key' ? { key: randomUUID() } : {}) };
    let release!: () => void, started!: () => void, blocker = 0;
    const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { started = r; });
    const first = h.worker.sql.begin(async tx => { blocker = Number((await tx`select pg_backend_pid() p`)[0].p); await h.prepareIntent(tx, a); started(); await gate; return h.applyIntent(tx); });
    let second: Promise<{ result?: unknown; error?: unknown }> | undefined;
    try {
      await Promise.race([locked, first]); const waiter = Number((await h.peer`select pg_backend_pid() p`)[0].p);
      second = h.accept(b, h.peer).then(result => ({ result }), (error: unknown) => ({ error })); await waitFor(blocker, waiter);
      release(); const accepted = await first, later = await second;
      if (kind === 'same-key-exact') expect(later).toEqual({ result: accepted }); else expect(later.error).toBeDefined();
      expect(await h.db.sql`select 1 from first_capture_intent_acceptances where payment_id=${f.paymentId}`).toHaveLength(1);
      expect(await h.db.sql`select 1 from payment_attempts where payment_id=${f.paymentId} and kind='CAPTURE'`).toHaveLength(1);
    } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
  it.each(['source-first', 'intent-first'] as const)('serializes source publication and intent in %s order', async order => {
    const f = await h.fixture(), r = await h.request(f);
    let release!: () => void, started!: () => void, blocker = 0, hold = false;
    const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { started = r; });
    const publication: ObservationTransactions = { transaction: work => h.publication.transaction(async tx => {
      const result = await work(tx); if (hold) { blocker = Number((await tx`select pg_backend_pid() p`)[0].p); started(); await gate; } return result;
    }) };
    const pending = await f.exchange(f.object, order === 'source-first' ? publication : h.publication);
    let first: Promise<unknown>, second: Promise<{ error?: unknown }> | undefined;
    if (order === 'source-first') { hold = true; first = pending.publish(); }
    else first = h.worker.sql.begin(async tx => { blocker = Number((await tx`select pg_backend_pid() p`)[0].p); await h.prepareIntent(tx, r); started(); await gate; return h.applyIntent(tx); });
    try {
      await Promise.race([locked, first]); const waiter = Number((await (order === 'source-first' ? h.worker.sql : h.observationSql)`select pg_backend_pid() p`)[0].p);
      second = (order === 'source-first' ? h.accept(r) : pending.publish()).then(() => ({}), (error: unknown) => ({ error }));
      await waitFor(blocker, waiter); release(); await first; const later = await second;
      if (order === 'source-first') { expect(later.error).toBeDefined(); expect(await h.db.sql`select 1 from first_capture_intent_acceptances where payment_id=${f.paymentId}`).toHaveLength(0); }
      else { expect(later.error).toBeUndefined(); expect(await h.db.sql`select 1 from first_capture_intent_acceptances where payment_id=${f.paymentId}`).toHaveLength(1); }
      await expect(h.inspect(f)).rejects.toThrow(); expect((await h.recognize(f))[0].id).toBe(f.rootId);
    } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
  it('an independent EUR scope commits while a USD intent is held', async () => {
    const f = await h.fixture(), g = await h.fixture({ currency: 'EUR' }), a = await h.request(f), b = await h.request(g);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { started = r; });
    const first = h.worker.sql.begin(async tx => { await h.prepareIntent(tx, a); started(); await gate; return h.applyIntent(tx); });
    try { await Promise.race([locked, first]); expect((await h.accept(b, h.peer))[0].result.body.paymentId).toBe(g.paymentId); release(); await first; }
    finally { release(); await Promise.allSettled([first]); }
  });
  it('refuses REPEATABLE READ rather than reusing a stale eligibility snapshot', async () => {
    const f = await h.fixture(), r = await h.request(f), before = await state(f);
    await expect(h.worker.sql.begin('isolation level repeatable read', tx => h.acceptIn(tx, r))).rejects.toThrow(/READ COMMITTED/);
    expect(await state(f)).toEqual(before);
  });
});
