import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ObservationTransactions } from '../../src/payment-provider/provider-observation-database';
import { manualAuthorizationHarness } from '../support/manual-authorization-harness';
import { paymentOperationHarness } from '../support/payment-operation-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30000);
describeDb('P-B atomic MANUAL authorization application', () => {
  let h: Awaited<ReturnType<typeof manualAuthorizationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  beforeAll(async () => { h = await manualAuthorizationHarness(); await h.install(); }, 30000);
  afterAll(async () => { if (h) await h.close(); });
  async function state(f: Fixture) {
    const [row] = await h.db.sql`select
      (select to_jsonb(p) from payments p where id=${f.paymentId}) payment,
      (select to_jsonb(a) from payment_attempts a where id=${f.attemptId}) attempt,
      (select to_jsonb(w) from webhook_events w where id=${f.inboxId}) inbox,
      (select evidence_revision::text from capture_accounting_scopes where merchant_id=${f.merchantId} and currency=${f.currency}) revision,
      (select count(*)::int from financial_application_roots where accepted_outbox_id=${f.outboxId}) roots,
      (select count(*)::int from financial_application_manifests where payment_id=${f.paymentId}) manifests,
      (select count(*)::int from financial_applications a join financial_application_roots r on r.id=a.root_id where r.payment_id=${f.paymentId}) applications,
      (select count(*)::int from financial_application_dispositions d join financial_application_roots r on r.id=d.root_id where r.payment_id=${f.paymentId}) dispositions,
      (select count(*)::int from financial_application_revision_effects e join financial_application_roots r on r.id=e.root_id where r.payment_id=${f.paymentId}) revisions,
      (select count(*)::int from audit_logs where target_id=${f.paymentId} and action='payment.authorized') audits,
      (select count(*)::int from ledger_transactions where merchant_id=${f.merchantId}) journals,
      (select count(*)::int from capture_accounting_lots where payment_id=${f.paymentId}) lots,
      (select count(*)::int from financial_application_effect_links where payment_id=${f.paymentId}) links,
      (select count(*)::int from payment_attempts where payment_id=${f.paymentId} and kind<>'AUTHORIZE') children,
      (select count(*)::int from provider_command_authorities where payment_id=${f.paymentId} and operation<>'AUTHORIZE') commands`;
    return row;
  }
  async function ready(f: Fixture) {
    const generation = await h.claim(f); expect(generation).not.toBeNull();
    return { generation: generation!, rev: await h.revisions(f) };
  }
  async function refused(f: Fixture, overrides: Partial<Fixture> = {}, revision?: Record<string, string>, generation?: number) {
    const claim = await ready(f), before = await state(f);
    await expect(h.worker.sql.begin(async tx => {
      await h.prepare(tx, { ...f, ...overrides }, generation ?? claim.generation, { ...claim.rev, ...revision });
      await h.apply(tx);
    })).rejects.toMatchObject({ code: expect.any(String) as string });
    expect(await state(f)).toEqual(before);
  }
  it.each([1, 10000, Number.MAX_SAFE_INTEGER])('commits genuine restricted MANUAL AUTH for H=%s with exactly one complete no-capture group', async amount => {
    const f = await h.fixture({ amount }), claim = await ready(f), before = await state(f);
    const [result] = await h.worker.sql.begin(async tx => {
      const [prepared] = await h.prepare(tx, f, claim.generation, claim.rev);
      const [manifest] = await tx<{ id: string; xid: string; pid: number }[]>`select (public.current_financial_application_manifest()).*,pg_current_xact_id()::text xid,pg_backend_pid() pid`;
      expect(manifest).toMatchObject({ id: prepared.id, proof_kind: 'PAYMENT_OPERATION_V1', payment_operation_proof_id: f.proofId,
        inbox_id: f.inboxId, claim_generation: claim.generation, result: 'VERIFIED_NO_EFFECT', transaction_id: manifest.xid, backend_pid: manifest.pid });
      const result = await h.apply(tx); await tx`set constraints all immediate`; return result;
    });
    const after = await state(f);
    expect(after).toMatchObject({ roots: 1, manifests: 1, applications: 1, dispositions: 2, revisions: 1, audits: 1,
      journals: 0, lots: 0, links: 0, children: 0, commands: 0 });
    expect(after.payment).toMatchObject({ status: 'AUTHORIZED', authorized_amount: amount, captured_amount: 0, platform_fee_amount: 0,
      refunded_amount: 0, version: Number((before.payment as { version: number }).version) + 1 });
    expect(after.attempt).toMatchObject({ status: 'SUCCEEDED', provider_transaction_id: f.pi, amount, failure_code: null });
    expect(after.inbox).toMatchObject({ status: 'PROCESSED', attempts: claim.generation, locked_at: null });
    expect(BigInt(after.revision as string)).toBe(BigInt(claim.rev.scope) + 1n);
    const [root] = await h.db.sql`select * from financial_application_roots where id=${String(result.id)}`;
    expect(root).toMatchObject({ family: 'AUTHORIZE', operation_id: f.attemptId, attempt_id: f.attemptId, accepted_outbox_id: f.outboxId,
      payment_id: f.paymentId, merchant_id: f.merchantId, currency: 'USD', policy: 'LEGACY', acceptance_epoch: '0' });
    const [audit] = await h.db.sql`select * from audit_logs where target_id=${f.paymentId} and action='payment.authorized'`;
    expect(audit).toMatchObject({ actor_type: 'PROVIDER', actor_id: f.pi, target_type: 'payment', merchant_id: f.merchantId });
    expect((await h.db.sql`select disposition from receipt_admission_obligations where inbox_id=${f.inboxId}`)[0].disposition).toBe('AWAITING_APPLICATION');
    expect((await h.db.sql`select disposition from provider_observation_obligations where source_id=${f.sourceId}`)[0].disposition).toBe('AWAITING_APPLICATION');
    await expect(h.inspect(f)).resolves.toHaveLength(1);
  });
  it('recognizes only the original completed source read-only without another permit, claim or revision', async () => {
    const f = await h.fixture(), [done] = await h.complete(f), before = await state(f);
    for (let i = 0; i < 2; i++) expect((await h.recognize(f))[0].id).toBe(done.id);
    await expect(h.claim(f)).rejects.toThrow(/not claimable/);
    expect((await h.worker.sql`select public.fail_manual_authorization(${f.inboxId},1) changed`)[0].changed).toBe(false);
    expect(await state(f)).toEqual(before);
    expect(await h.db.sql`select 1 from financial_application_permits p join financial_application_manifests m on m.id=p.manifest_id where m.payment_id=${f.paymentId}`).toHaveLength(1);
    await expect(h.worker.sql`select public.apply_manual_authorization()`).rejects.toThrow();
  });
  it('an exact D02 publication retry retains its original source and creates no second blocker', async () => {
    const f = await h.fixture(), repeated = await f.observed.publish();
    expect(repeated).toHaveLength(1); expect(repeated[0].id).toBe(f.sourceId);
    await h.complete(f); await expect(h.inspect(f)).resolves.toHaveLength(1);
  });
  it('retains currency ownership for EUR and rejects a foreign-currency proof selector', async () => {
    const usd = await h.fixture(), euro = await h.fixture({ currency: 'EUR' });
    await refused(usd, { proofId: euro.proofId });
    const [done] = await h.complete(euro);
    expect((await h.db.sql`select currency from financial_application_roots where id=${done.id}`)[0].currency).toBe('EUR');
    expect((await state(euro)).payment).toMatchObject({ currency: 'EUR', captured_amount: 0, authorized_amount: 10000 });
    await expect(h.inspect(euro)).resolves.toHaveLength(1);
  });
  it.each(['CAPTURE', 'VOID'] as const)('keeps enrolled %s issuance closed while preserving the unenrolled P-A fixture contract', async operation => {
    const inert = await paymentOperationHarness();
    try {
      // Existing B1 structural evidence is deliberately not a protected P-C intent.
      const f = await inert.fixture({ operation });
      await inert.db.sql`insert into financial_application_contracts(family,phase,policy,version,prepare_function,validate_function)
        values('AUTHORIZE','TERMINAL','LEGACY',1,'public.prepare_manual_authorization(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure,
        'public.validate_manual_authorization(uuid)'::regprocedure)`;
      await inert.db.sql`insert into financial_application_scope_authority values(${f.merchantId},'USD','STRIPE',${f.account},'LEGACY',0,'DORMANT')`;
      await expect(inert.db.sql`insert into financial_application_roots(family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,attempt_id)
        values(${operation},${f.accepted.id},'TERMINAL',${f.merchantId},'USD','STRIPE',${f.account},'LEGACY',0,${f.accepted.outboxId},${f.paymentId},${f.accepted.id})`).rejects.toThrow('Enrolled CAPTURE/VOID application authority is not installed');
      expect(await inert.db.sql`select 1 from financial_application_roots`).toHaveLength(0);
    } finally { await inert.close(); }
  });
  it.each(['outbox', 'inbox', 'proof', 'combined'] as const)('rejects foreign %s selectors without partial application', async field => {
    const f = await h.fixture(), foreign = await h.fixture();
    const overrides = field === 'outbox' ? { outboxId: foreign.outboxId } : field === 'inbox' ? { inboxId: foreign.inboxId }
      : field === 'proof' ? { proofId: foreign.proofId } : { inboxId: foreign.inboxId, proofId: foreign.proofId };
    await refused(f, overrides);
  });
  it.each(['outboxId', 'inboxId', 'proofId'] as const)('rejects missing original %s', async key => { const f = await h.fixture(); await refused(f, { [key]: randomUUID() }); });
  it.each(['obligation', 'scope', 'intake'] as const)('rejects stale %s revision under its locks', async key => { const f = await h.fixture(); await refused(f, {}, { [key]: '-1' }); });
  it('rejects a stale claim generation', async () => { const f = await h.fixture(); await refused(f, {}, undefined, 0); });
  it('refuses AUTOMATIC without creating an automatic capture child', async () => { const f = await h.fixture({ automatic: true }); await refused(f); });
  it.each(['amount', 'authorized', 'succeeded', 'failed', 'reference', 'extra-attempt'] as const)('refuses incompatible initial %s state', async kind => {
    const f = await h.fixture({ enroll: false });
    if (kind === 'amount') await h.db.sql`update payments set amount=amount+1 where id=${f.paymentId}`;
    if (kind === 'authorized') await h.db.sql`update payments set status='AUTHORIZED',authorized_amount=amount where id=${f.paymentId}`;
    if (kind === 'succeeded') await h.db.sql`update payment_attempts set status='SUCCEEDED',provider_transaction_id=${f.pi} where id=${f.attemptId}`;
    if (kind === 'failed') await h.db.sql`update payment_attempts set status='FAILED',failure_code='fixture_failure' where id=${f.attemptId}`;
    if (kind === 'reference') await h.db.sql`update payment_attempts set provider_transaction_id='pi_foreign' where id=${f.attemptId}`;
    if (kind === 'extra-attempt') await h.db.sql`insert into payment_attempts(merchant_id,payment_id,kind,amount,currency) values(${f.merchantId},${f.paymentId},'VOID',0,'USD')`;
    await f.enroll(); await refused(f);
  });
  it('refuses genuine LIVE-mode evidence without changing immutable account configuration', async () => {
    const f = await h.fixture({ mode: 'LIVE' }), before = await state(f);
    expect((await h.db.sql`select provider_mode from payment_operation_evidence where id=${f.proofId}`)[0].provider_mode).toBe('LIVE');
    await expect(h.claim(f)).rejects.toThrow(/Bound private AUTH obligation required/);
    expect(await state(f)).toEqual(before);
  });
  it('refuses a preexisting incomplete canonical root rather than repairing it', async () => {
    const f = await h.fixture({ enroll: false });
    await h.db.sql`insert into financial_application_roots(family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,attempt_id)
      values('AUTHORIZE',${f.attemptId},'TERMINAL',${f.merchantId},'USD','STRIPE',${f.account},'LEGACY',0,${f.outboxId},${f.paymentId},${f.attemptId})`;
    await f.enroll(); await refused(f);
  });
  it('refuses an unbound sealed proof and retains its unknown obligation', async () => {
    const f = await h.fixture({ bind: false }), before = await state(f);
    await expect(h.claim(f)).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it.each(['equivalent', 'contradictory', 'unknown'] as const)('retains an additional %s D02 source as a blocker', async kind => {
    const f = await h.fixture(), object = structuredClone(f.object);
    if (kind === 'contradictory') object.amount_received = 1;
    if (kind === 'unknown') object.status = 'requires_action';
    await (await f.exchange(object)).publish(); await refused(f);
  });
  it('retains another genuine signed AUTH receipt as an independent blocker', async () => {
    const f = await h.fixture(); await f.receive({ ...f.event, id: `evt_${randomUUID()}` }); await refused(f);
  });
  it('retains an OPEN scoped accounting exception as an independent blocker', async () => {
    const f = await h.fixture();
    await h.db.sql`insert into accounting_exceptions(merchant_id,currency,payment_id,category,source_kind,evidence_key,observed_conflict)
      values(${f.merchantId},'USD',${f.paymentId},'AMBIGUOUS_PROVIDER_NET_EFFECT','INTERNAL',${`pb:${randomUUID()}`},'{}')`;
    await refused(f);
  });
  it('retains a contradictory signed delivery barrier', async () => {
    const f = await h.fixture(), event = structuredClone(f.event); event.data.object.amount_received = 1;
    await f.receive(event); await refused(f);
    expect(await h.db.sql`select 1 from receipt_delivery_barriers where provider='STRIPE' and provider_account=${f.account}`).not.toHaveLength(0);
  });
  it('a later source keeps current admission blocked while original historical recognition remains read-only', async () => {
    const f = await h.fixture(), [done] = await h.complete(f);
    await (await f.exchange()).publish(); const before = await state(f);
    await expect(h.inspect(f)).rejects.toThrow(); expect((await h.recognize(f))[0].id).toBe(done.id); expect(await state(f)).toEqual(before);
  });
  it('uncompleted history cannot be recognized from an inbox/proof UUID', async () => { const f = await h.fixture(); await expect(h.recognize(f)).rejects.toThrow(); });
  it('does not install executable AUTH authority merely by applying the migration', async () => {
    const closed = await manualAuthorizationHarness();
    try {
      const f = await closed.fixture(), generation = await closed.claim(f), rev = await closed.revisions(f);
      await expect(closed.worker.sql.begin(tx => closed.prepare(tx, f, generation!, rev))).rejects.toThrow(/not installed/);
      expect(await closed.db.sql`select 1 from financial_application_contracts`).toHaveLength(0);
      expect(await closed.db.sql`select 1 from financial_applications`).toHaveLength(0);
    } finally { await closed.close(); }
  });
  it('prepare-only COMMIT rejects and rolls back root, manifest and permit', async () => {
    const f = await h.fixture(), c = await ready(f), before = await state(f);
    await expect(h.worker.sql.begin(tx => h.prepare(tx, f, c.generation, c.rev))).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it('an incomplete group fails SET CONSTRAINTS IMMEDIATE', async () => {
    const f = await h.fixture(), c = await ready(f), before = await state(f);
    await expect(h.worker.sql.begin(async tx => { await h.prepare(tx, f, c.generation, c.rev); await tx`set constraints all immediate`; })).rejects.toThrow();
    expect(await state(f)).toEqual(before);
  });
  it('late rollback after complete immediate validation preserves original proof and binding only', async () => {
    const f = await h.fixture(), c = await ready(f), before = await state(f);
    await expect(h.worker.sql.begin(async tx => { await h.prepare(tx, f, c.generation, c.rev); await h.apply(tx); await tx`set constraints all immediate`; throw new Error('P-B late rollback'); })).rejects.toThrow('P-B late rollback');
    expect(await state(f)).toEqual(before);
    expect(await h.db.sql`select 1 from payment_operation_evidence where id=${f.proofId}`).toHaveLength(1);
    await h.worker.sql.begin(async tx => { await h.prepare(tx, f, c.generation, c.rev); await h.apply(tx); });
  });
  it('savepoint rollback removes its permit before a fresh exact preparation in the same transaction', async () => {
    const f = await h.fixture(), c = await ready(f);
    await h.worker.sql.begin(async tx => {
      let first: unknown;
      await expect(tx.savepoint(async nested => { first = (await h.prepare(nested, f, c.generation, c.rev))[0].id; throw new Error('P-B savepoint'); })).rejects.toThrow('P-B savepoint');
      await expect(tx.savepoint(nested => h.apply(nested))).rejects.toThrow();
      expect((await h.prepare(tx, f, c.generation, c.rev))[0].id).not.toBe(first); await h.apply(tx);
    });
  });
  it('one top-level transaction cannot hold two application permits', async () => {
    const f = await h.fixture(), g = await h.fixture(), a = await ready(f), b = await ready(g), before = await state(f);
    await expect(h.worker.sql.begin(async tx => { await h.prepare(tx, f, a.generation, a.rev); await h.prepare(tx, g, b.generation, b.rev); })).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it('a second backend and next transaction cannot borrow a prepared permit', async () => {
    const f = await h.fixture(), c = await ready(f);
    await h.worker.sql.begin(async tx => { await h.prepare(tx, f, c.generation, c.rev); await expect(h.peer`select public.apply_manual_authorization()`).rejects.toThrow(); await h.apply(tx); });
    await expect(h.worker.sql`select public.apply_manual_authorization()`).rejects.toThrow();
  });
  it('caller JSON/GUC does not create application authority', async () => {
    await expect(h.worker.sql.begin(async tx => { await tx`select set_config('app.financial_permit',${JSON.stringify({ approved: true, id: randomUUID() })},true)`; await h.apply(tx); })).rejects.toThrow();
  });
  it.each(['financial_application_roots', 'financial_application_manifests', 'financial_application_permits', 'financial_applications',
    'financial_application_dispositions', 'financial_application_contracts', 'financial_application_scope_authority', 'audit_logs', 'ledger_transactions'])('worker has no direct %s INSERT', async table => {
    await expect(h.worker.sql.unsafe(`insert into public.${table} default values`)).rejects.toMatchObject({ code: '42501' });
  });
  it('ordinary LOGIN has no private AUTH capability or owner membership', async () => {
    const f = await h.fixture(); await expect(h.ordinary.sql`select public.claim_manual_authorization(${f.inboxId})`).rejects.toMatchObject({ code: '42501' });
    expect(await h.db.sql`select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=${h.worker.role})`).toHaveLength(0);
    await expect(h.worker.sql.unsafe(`set role "fintech_application_${(await h.db.sql`select md5(current_database()) n`)[0].n}"`)).rejects.toMatchObject({ code: '42501' });
  });
  it('additional root INSERT and SELECT grants cannot forge the protected SQL issuer', async () => {
    const f = await h.fixture(), attacker = await h.login('root_forgery'), before = await state(f);
    await h.db.sql.unsafe(`grant select on financial_application_roots,financial_application_scope_authority,financial_application_manifests to "${attacker.role}"`);
    await h.db.sql.unsafe(`grant insert on financial_application_roots,financial_application_manifests,financial_application_permits to "${attacker.role}"`);
    await expect(attacker.sql`insert into financial_application_roots(family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,attempt_id)
      values('AUTHORIZE',${f.attemptId},'TERMINAL',${f.merchantId},'USD','STRIPE',${f.account},'LEGACY',0,${f.outboxId},${f.paymentId},${f.attemptId})`).rejects.toMatchObject({ code: 'P0001' });
    expect(await state(f)).toEqual(before);
  });
  it.each(['uppercase', 'braces', 'hyphenless'] as const)('normalizes %s UUID targets before protecting an AUTH audit', async format => {
    const f = await h.fixture(), attacker = await h.login('audit_uuid'), before = await state(f);
    const target = format === 'uppercase' ? f.paymentId.toUpperCase() : format === 'braces' ? `{${f.paymentId}}` : f.paymentId.replaceAll('-', '');
    await h.db.sql.unsafe(`grant insert on audit_logs to "${attacker.role}"`);
    await expect(attacker.sql`insert into audit_logs(merchant_id,actor_type,action,target_type,target_id,metadata)
      values(null,'PROVIDER','payment.authorized','payment',${target},'{}')`).rejects.toMatchObject({ code: 'P0001' });
    expect(await state(f)).toEqual(before);
    expect(await h.db.sql`select 1 from audit_logs where target_id=${target}`).toHaveLength(0);
  });
  it.each([
    ['proofId', 'payment.authorized'], ['rootId', 'payment.authorized'],
    ['proofId', 'unrelated'], ['rootId', 'unrelated'],
  ] as const)('normalizes uppercase %s metadata with action %s before protecting an AUTH audit', async (field, action) => {
    const f = await h.fixture(), [done] = await h.complete(f), attacker = await h.login('audit_metadata'), before = await state(f);
    const metadata = { [field]: (field === 'proofId' ? f.proofId : String(done.id)).toUpperCase() };
    await h.db.sql.unsafe(`grant insert on audit_logs to "${attacker.role}"`);
    await expect(attacker.sql`insert into audit_logs(merchant_id,actor_type,action,target_type,target_id,metadata)
      values(null,'PROVIDER',${action},'payment','opaque-audit-target',${attacker.sql.json(metadata)})`).rejects.toMatchObject({ code: 'P0001' });
    expect(await state(f)).toEqual(before);
  });
  it.each(['target', 'proof'] as const)('refuses preexisting terminal AUTH audit history identified by %s', async reference => {
    const f = await h.fixture({ enroll: false }), audit = randomUUID();
    await h.db.sql`insert into audit_logs(id,merchant_id,actor_type,action,target_type,target_id,metadata)
      values(${audit},null,'PROVIDER','payment.authorized','payment',${reference === 'target' ? f.paymentId : 'opaque-audit-target'},
      ${h.db.sql.json(reference === 'proof' ? { proofId: f.proofId.toUpperCase() } : {})})`;
    await f.enroll(); const claim = await ready(f), before = await state(f);
    await expect(h.worker.sql.begin(async tx => {
      await h.prepare(tx, f, claim.generation, claim.rev); await h.apply(tx);
    })).rejects.toThrow('Unrecognized prior authorization audit history');
    expect(await state(f)).toEqual(before);
    expect(await h.db.sql`select 1 from audit_logs where id=${audit}`).toHaveLength(1);
    expect(await state(f)).toMatchObject({ roots: 0, applications: 0, dispositions: 0, revisions: 0 });
    expect(await h.db.sql`select 1 from payment_operation_evidence where id=${f.proofId}`).toHaveLength(1);
  });
  it('stale failure bookkeeping cannot downgrade another generation or completed success', async () => {
    const f = await h.fixture(), c = await ready(f);
    expect((await h.worker.sql`select public.fail_manual_authorization(${f.inboxId},${c.generation - 1}) changed`)[0].changed).toBe(false);
    await h.worker.sql.begin(async tx => { await h.prepare(tx, f, c.generation, c.rev); await h.apply(tx); });
    expect((await h.worker.sql`select public.fail_manual_authorization(${f.inboxId},${c.generation}) changed`)[0].changed).toBe(false);
    expect((await state(f)).inbox).toMatchObject({ status: 'PROCESSED', attempts: c.generation });
  });
  it('failure after application rollback retains no application and records bounded retry separately', async () => {
    const f = await h.fixture(), c = await ready(f);
    await expect(h.worker.sql.begin(async tx => { await h.prepare(tx, f, c.generation, c.rev); await h.apply(tx); throw new Error('P-B apply abort'); })).rejects.toThrow('P-B apply abort');
    expect((await h.worker.sql`select public.fail_manual_authorization(${f.inboxId},${c.generation}) changed`)[0].changed).toBe(true);
    expect(await state(f)).toMatchObject({ applications: 0, roots: 0, dispositions: 0, revisions: 0, audits: 0 });
    expect((await state(f)).inbox).toMatchObject({ status: 'RETRY', attempts: c.generation });
  });
  it('the eighth failed claim becomes DEAD and cannot be reclaimed', async () => {
    const f = await h.fixture({ enroll: false });
    await h.db.sql`update webhook_events set attempts=7 where id=${f.inboxId}`;
    await f.enroll(); const generation = await h.claim(f); expect(generation).toBe(8);
    expect((await h.worker.sql`select public.fail_manual_authorization(${f.inboxId},8) changed`)[0].changed).toBe(true);
    expect((await state(f)).inbox).toMatchObject({ status: 'DEAD', attempts: 8 });
    await expect(h.claim(f)).rejects.toThrow(/not claimable/);
  });
  it('even an additional direct journal writer cannot use a prepared AUTH plan for money', async () => {
    const f = await h.fixture(), generation = await h.claim(f, h.db.sql), rev = await h.revisions(f), before = await state(f);
    await expect(h.db.sql.begin(async tx => {
      await h.prepare(tx, f, generation!, rev);
      await tx`insert into ledger_transactions(merchant_id,business_type,business_id,currency,description)
        values(${f.merchantId},'AUTHORIZE',${f.attemptId},'USD','P-B forbidden monetary effect')`;
    })).rejects.toMatchObject({ code: 'P0001' });
    expect(await state(f)).toEqual(before);
  });
  it.each(['payments', 'payment_attempts', 'audit_logs', 'webhook_events'] as const)('extra column grants cannot write protected %s without a P group', async table => {
    const f = await h.fixture(), attacker = await h.login('column'), before = await state(f);
    if (table === 'payments') {
      await h.db.sql.unsafe(`grant update(status,authorized_amount),select(id,amount) on payments to "${attacker.role}"`);
      await expect(attacker.sql`update payments set status='AUTHORIZED',authorized_amount=amount where id=${f.paymentId}`).rejects.toThrow();
    } else if (table === 'payment_attempts') {
      await h.db.sql.unsafe(`grant update(status,provider_transaction_id),select(id) on payment_attempts to "${attacker.role}"`);
      await expect(attacker.sql`update payment_attempts set status='SUCCEEDED',provider_transaction_id=${f.pi} where id=${f.attemptId}`).rejects.toThrow();
    } else if (table === 'audit_logs') {
      await h.db.sql.unsafe(`grant insert on audit_logs to "${attacker.role}"`);
      await expect(attacker.sql`insert into audit_logs(merchant_id,actor_type,action,target_type,target_id) values(null,'PROVIDER','payment.authorized','payment',${f.paymentId})`).rejects.toThrow();
    } else {
      await h.db.sql.unsafe(`grant update(status),select(id) on webhook_events to "${attacker.role}"`);
      await expect(attacker.sql`update webhook_events set status='PROCESSED' where id=${f.inboxId}`).rejects.toThrow();
    }
    expect(await state(f)).toEqual(before);
  });
  it.each([
    ['root', 'financial_application_roots', 'INSERT', 'NEW.accepted_outbox_id'],
    ['manifest', 'financial_application_manifests', 'INSERT', 'NEW.payment_id'],
    ['permit', 'financial_application_permits', 'INSERT', "(select payment_id from financial_application_manifests where id=NEW.manifest_id)"],
    ['payment', 'payments', 'UPDATE', 'NEW.id'], ['attempt', 'payment_attempts', 'UPDATE', 'NEW.payment_id'],
    ['audit', 'audit_logs', 'INSERT', 'NEW.target_id::uuid'], ['inbox completion', 'webhook_events', 'UPDATE', 'NEW.id'],
    ['application', 'financial_applications', 'INSERT', '(select payment_id from financial_application_roots where id=NEW.root_id)'],
    ['receipt disposition', 'financial_application_dispositions', 'INSERT', 'NEW.inbox_id'],
    ['D02 disposition', 'financial_application_dispositions', 'INSERT', 'NEW.observation_source_id'],
    ['revision effect', 'financial_application_revision_effects', 'INSERT', '(select payment_id from financial_application_roots where id=NEW.root_id)'],
  ] as const)('cannot commit when the entire %s group is omitted by an injected test fault', async (group, table, event, selector) => {
    const f = await h.fixture(), c = await ready(f), before = await state(f);
    const target = group === 'root' ? f.outboxId : group === 'inbox completion' || group === 'receipt disposition' ? f.inboxId : group === 'D02 disposition' ? f.sourceId : f.paymentId;
    // A disposable test trigger drops one actual write; production guards remain
    // enabled and must reject the resulting incomplete transaction themselves.
    await h.db.sql.unsafe(`create function public.pb_test_omit() returns trigger language plpgsql as $body$ begin if ${selector}='${target}'::uuid then ${event === 'UPDATE' ? 'return OLD' : 'return NULL'}; end if; return NEW; end $body$`);
    await h.db.sql.unsafe(`create trigger zz_pb_test_omit before ${event} on public.${table} for each row execute function public.pb_test_omit()`);
    try { await expect(h.worker.sql.begin(async tx => { await h.prepare(tx, f, c.generation, c.rev); await h.apply(tx); })).rejects.toThrow(); expect(await state(f)).toEqual(before); }
    finally { await h.db.sql.unsafe(`drop trigger zz_pb_test_omit on public.${table}`); await h.db.sql`drop function public.pb_test_omit()`; }
  });
  async function waitFor(blocker: number, waiter: number) {
    expect(waiter).not.toBe(blocker);
    for (let i = 0; i < 150; i++) { if ((await h.db.sql`select ${blocker}=any(pg_blocking_pids(${waiter})) blocked`)[0].blocked) return; await delay(20); }
    throw new Error('P-B expected lock wait was not observed');
  }
  it.each(['inbox', 'account', 'advisory', 'scope'] as const)('recognition waits for the approved %s gate without changing evidence', async gateName => {
    const f = await h.fixture(), [done] = await h.complete(f), before = await state(f);
    let release!: () => void, started!: () => void, blocker = 0;
    const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { started = r; });
    const holder = h.db.transaction(async tx => {
      blocker = Number((await tx`select pg_backend_pid() p`)[0].p);
      if (gateName === 'inbox') await tx`select 1 from webhook_events where id=${f.inboxId} for update`;
      if (gateName === 'account') await tx`select 1 from financial_evidence_accounts where provider='STRIPE' and provider_account=${f.account} for update`;
      if (gateName === 'advisory') await tx`select pg_advisory_xact_lock(hashtextextended(${f.merchantId}::text||':'||${f.currency},0))`;
      if (gateName === 'scope') await tx`select 1 from capture_accounting_scopes where merchant_id=${f.merchantId} and currency=${f.currency} for no key update`;
      started(); await gate;
    });
    let recognition: ReturnType<typeof h.recognize> | undefined, settled = false;
    try {
      await Promise.race([locked, holder]); const waiter = Number((await h.worker.sql`select pg_backend_pid() p`)[0].p);
      recognition = h.recognize(f); void recognition.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(blocker, waiter); expect(settled).toBe(false);
      release(); await holder; expect((await recognition)[0].id).toBe(done.id);
      expect(await state(f)).toEqual(before);
    } finally { release(); await Promise.allSettled([holder, ...(recognition ? [recognition] : [])]); }
  });
  it('recognition refuses REPEATABLE READ rather than using a stale historical snapshot', async () => {
    const f = await h.fixture(); await h.complete(f); const before = await state(f);
    await expect(h.worker.sql.begin('isolation level repeatable read', tx => tx`select public.recognize_manual_authorization(${f.outboxId},${f.inboxId},${f.proofId})`)).rejects.toThrow(/READ COMMITTED/);
    expect(await state(f)).toEqual(before);
  });
  it('two authenticated claim workers elect one current generation', async () => {
    const f = await h.fixture(), values = await Promise.allSettled([h.claim(f), h.claim(f, h.peer)]);
    expect(values.filter(value => value.status === 'fulfilled').map(value => value.value)).toEqual([1]);
    expect(values.filter(value => value.status === 'rejected')).toHaveLength(1);
    const c = { generation: 1, rev: await h.revisions(f) };
    await h.worker.sql.begin(async tx => { await h.prepare(tx, f, c.generation, c.rev); await h.apply(tx); });
    expect(await state(f)).toMatchObject({ applications: 1, audits: 1, dispositions: 2 });
  });
  it('concurrent same-root application waits on the original inbox and applies once', async () => {
    const f = await h.fixture(), c = await ready(f); let release!: () => void, started!: () => void, blocker = 0;
    const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { started = r; });
    const first = h.worker.sql.begin(async tx => { blocker = Number((await tx`select pg_backend_pid() p`)[0].p); await h.prepare(tx, f, c.generation, c.rev); started(); await gate; return h.apply(tx); });
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([locked, first]); const waiter = Number((await h.peer`select pg_backend_pid() p`)[0].p);
      second = h.peer.begin(tx => h.prepare(tx, f, c.generation, c.rev)).then(value => ({ value }), (error: unknown) => ({ error }));
      await waitFor(blocker, waiter); release(); await first; const outcome = await second as { error?: unknown };
      expect(outcome.error).toBeDefined(); await h.recognize(f);
      expect(await state(f)).toMatchObject({ applications: 1, audits: 1, revisions: 1, dispositions: 2 });
    } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
  it.each(['publication-first', 'application-first'] as const)('serializes source publication and AUTH in %s order', async order => {
    const f = await h.fixture(), c = await ready(f);
    let release!: () => void, started!: () => void, blocker = 0;
    const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { started = r; });
    let hold = false;
    const publication: ObservationTransactions = { transaction: work => h.publication.transaction(async tx => {
      const result = await work(tx);
      if (hold) { blocker = Number((await tx`select pg_backend_pid() p`)[0].p); started(); await gate; }
      return result;
    }) };
    const pending = await f.exchange(f.object, order === 'publication-first' ? publication : h.publication);
    let first: Promise<unknown>, second: Promise<unknown> | undefined;
    if (order === 'publication-first') { hold = true; first = pending.publish(); }
    else first = h.worker.sql.begin(async tx => { blocker = Number((await tx`select pg_backend_pid() p`)[0].p); await h.prepare(tx, f, c.generation, c.rev); started(); await gate; await h.apply(tx); });
    try {
      await Promise.race([locked, first]);
      if (order === 'application-first') {
        const waiter = Number((await h.observationSql`select pg_backend_pid() p`)[0].p);
        second = pending.publish(); await waitFor(blocker, waiter); release(); await Promise.all([first, second]);
        expect((await state(f)).applications).toBe(1); await expect(h.inspect(f)).rejects.toThrow();
      } else {
        const waiter = Number((await h.worker.sql`select pg_backend_pid() p`)[0].p);
        second = h.worker.sql.begin(async tx => { await h.prepare(tx, f, c.generation, c.rev); await h.apply(tx); }).then(value => ({ value }), (error: unknown) => ({ error }));
        await waitFor(blocker, waiter); release(); await first;
        expect((await second as { error?: unknown }).error).toBeDefined(); expect((await state(f)).applications).toBe(0);
      }
    } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
  it.each(['seal', 'bind'] as const)('serializes %s replay and AUTH in both real lock orders', async operation => {
    for (const evidenceFirst of [true, false]) {
      const f = await h.fixture(), c = await ready(f); let release!: () => void, started!: () => void, blocker = 0;
      const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { started = r; });
      const correlate = () => h.receipt.correlator.begin(async tx => {
        if (operation === 'seal') expect((await tx`select public.seal_payment_operation_evidence(${f.inboxId},${c.generation},${c.rev.obligation},${f.sourceId},null) result`)[0].result).toMatchObject({ state: 'SEALED' });
        else await tx`select public.bind_payment_operation_obligation(${f.inboxId},${f.proofId},${c.rev.obligation})`;
        if (evidenceFirst) { blocker = Number((await tx`select pg_backend_pid() p`)[0].p); started(); await gate; }
      });
      const application = () => h.worker.sql.begin(async tx => {
        await h.prepare(tx, f, c.generation, c.rev);
        if (!evidenceFirst) { blocker = Number((await tx`select pg_backend_pid() p`)[0].p); started(); await gate; }
        await h.apply(tx);
      });
      const first = evidenceFirst ? correlate() : application(); let second: Promise<unknown> | undefined;
      try {
        await Promise.race([locked, first]);
        const waiter = Number((await (evidenceFirst ? h.worker.sql : h.receipt.correlator)`select pg_backend_pid() p`)[0].p);
        second = evidenceFirst ? application() : correlate(); await waitFor(blocker, waiter); release(); await Promise.all([first, second]);
        expect(await state(f)).toMatchObject({ applications: 1, audits: 1, dispositions: 2, revisions: 1, journals: 0, lots: 0 });
      } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
    }
  });
  it('refuses REPEATABLE READ rather than validating a stale transaction snapshot', async () => {
    const f = await h.fixture(), c = await ready(f), before = await state(f);
    await expect(h.worker.sql.begin('isolation level repeatable read', tx => h.prepare(tx, f, c.generation, c.rev))).rejects.toThrow();
    expect(await state(f)).toEqual(before);
  });
});
