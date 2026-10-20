import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { providerObservationHarness } from '../support/provider-observation-harness';
import { ScriptedStripeHttp } from '../support/provider-observation-harness';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { publishCommandObservation, signedEvidence } from '../support/trusted-evidence-fixtures';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
// The installed migration has NO operation contract. The administrator installs
// a private SQL probe only in this disposable test database. It never calculates
// or applies refund money and is not a production refund validator.
describeDb('R2-A structural authority and closed financial application protocol', () => {
  let h: Awaited<ReturnType<typeof providerObservationHarness>>, worker: Sql, peer: Sql, role: string;
  beforeAll(async () => {
    h = await providerObservationHarness();
    role = `r2a_worker_${randomUUID().replaceAll('-', '')}`;
    const password = randomBytes(32).toString('hex');
    await h.db.sql.unsafe(`create role "${role}" login password '${password}' noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await h.db.sql.unsafe(`grant usage on schema public to "${role}"`);
    await h.db.sql.unsafe(`grant execute on function public.prepare_financial_application(uuid,uuid,integer,integer,text),public.current_financial_application_manifest(),public.complete_financial_application() to "${role}"`);
    const url = new URL(process.env.MIGRATION_ADMIN_URL!);
    url.pathname = '/' + String((await h.db.sql`select current_database() n`)[0].n); url.username = role; url.password = password;
    worker = postgres(url.toString(), { max: 1, connection: { statement_timeout: 10000 } });
    peer = postgres(url.toString(), { max: 1, connection: { statement_timeout: 10000 } });
    await h.db.sql`create table public.r2a_structural_probe_plans(root_id uuid primary key, plan jsonb not null)`;
    await h.db.sql.unsafe(`create function public.r2a_structural_prepare(p uuid) returns jsonb language sql set search_path=pg_catalog,pg_temp as 'select plan from public.r2a_structural_probe_plans where root_id=p'`);
    await h.db.sql.unsafe(`create function public.r2a_structural_validate(p uuid) returns boolean language sql set search_path=pg_catalog,pg_temp as 'select false'`);
    const owner = String((await h.db.sql`select 'fintech_application_'||md5(current_database()) n`)[0].n);
    await h.db.sql.unsafe(`revoke all on function public.r2a_structural_prepare(uuid),public.r2a_structural_validate(uuid) from public`);
    await h.db.sql.unsafe(`grant select on public.r2a_structural_probe_plans to "${owner}"`);
    await h.db.sql.unsafe(`grant execute on function public.r2a_structural_prepare(uuid),public.r2a_structural_validate(uuid) to "${owner}"`);
  }, 30000);
  afterAll(async () => { if (worker) await worker.end(); if (peer) await peer.end(); if (h) await h.close(); });

  async function fixture(enroll = true) {
    const f = await h.accepted();
    await h.db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
    await h.db.sql`insert into refund_capture_allocations(refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross)
      values(${f.operationId},${f.lotId},${f.paymentId},${f.merchantId},'USD',2000)`;
    const [source] = await (await f.producer.execute(f.message)).publish();
    const signed = signedEvidence({ ...f, refundId: f.operationId, objectId: f.object.id }, { object: { amount: 2000 } });
    const attested = h.sign(signed.raw);
    const receipt = await h.receiver(f.account).receive(attested.raw, attested.signature, {});
    expect(await h.correlate(f.account).correlate(receipt.id)).toMatchObject({ state: 'BOUND' });
    const [r] = await h.db.sql<{ id: string }[]>`insert into financial_application_roots
      (family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,refund_id)
      values('REFUND',${f.operationId},'TERMINAL',${f.merchantId},'USD','STRIPE',${f.account},'LEGACY',0,${f.outboxId},${f.paymentId},${f.operationId}) returning id`;
    const [audit] = await h.db.sql<{ id: string }[]>`insert into audit_logs(merchant_id,actor_type,action,target_type,target_id,metadata)
      values(${f.merchantId},'SYSTEM','r2a.structural.probe','refund',${f.operationId},'{}') returning id`;
    await h.db.sql`insert into r2a_structural_probe_plans(root_id,plan) values(${r.id},${h.db.sql.json({ result: 'ZERO_EFFECT', sources: { audit_id: audit.id }, effects: [] })})`;
    await h.db.sql`update webhook_events set status='PROCESSING',attempts=1 where id=${receipt.id}`;
    if (enroll) await h.db.sql`insert into financial_application_scope_authority(merchant_id,currency,provider,provider_account,policy,epoch,admission_mode)
      values(${f.merchantId},'USD','STRIPE',${f.account},'LEGACY',0,'DORMANT')`;
    return { ...f, rootId: r.id, inboxId: receipt.id, sourceId: source.id, auditId: audit.id };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const prepare = (tx: TransactionSql, f: Fixture, generation = 1, revision = 1, operation = 'refund.succeeded') =>
    tx`select public.prepare_financial_application(${f.rootId},${f.inboxId},${generation},${revision},${operation}) id`;
  async function installProbe() {
    await h.db.sql`insert into financial_application_contracts(family,phase,policy,version,prepare_function,validate_function)
      values('REFUND','TERMINAL','LEGACY',1,'public.r2a_structural_prepare(uuid)'::regprocedure,'public.r2a_structural_validate(uuid)'::regprocedure)`;
  }
  async function counts(f: Fixture) {
    return (await h.db.sql`select (select count(*)::int from financial_applications where root_id=${f.rootId}) applications,
      (select count(*)::int from financial_application_dispositions where root_id=${f.rootId}) dispositions,
      (select count(*)::int from ledger_transactions where business_type='REFUND' and business_id=${f.operationId}) journals`)[0];
  }
  it('has no enabled production operation contract; valid owned evidence cannot open it', async () => {
    expect(await h.db.sql`select * from financial_application_contracts`).toHaveLength(0);
    const f = await fixture(); await expect(worker.begin(tx => prepare(tx, f))).rejects.toThrow(/not installed/);
    expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
    await installProbe();
  });
  it('issues server-derived top-level transaction/backend authority through a restricted LOGIN', async () => {
    const f = await fixture(); await worker.begin(async tx => {
      const [id] = await prepare(tx, f);
      const [m] = await tx`select (public.current_financial_application_manifest()).*,pg_current_xact_id()::text actual_xid,pg_backend_pid() actual_pid,session_user principal`;
      expect(m.id).toBe(id.id); expect(m.transaction_id).toBe(m.actual_xid); expect(m.backend_pid).toBe(m.actual_pid);
      expect(m).toMatchObject({ root_id: f.rootId, inbox_id: f.inboxId, proof_revision: 1, claim_generation: 1, policy: 'LEGACY', epoch: '0', principal: role });
    });
    expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
  });
  it('retained permit rows confer no authority in the next transaction on the same backend', async () => {
    const f = await fixture(); await worker.begin(tx => prepare(tx, f));
    await expect(worker.begin(tx => tx`select public.current_financial_application_manifest()`)).rejects.toThrow(/transaction\/backend/);
    expect(await h.db.sql`select 1 from financial_application_manifests where root_id=${f.rootId}`).toHaveLength(1);
  });
  it('cannot reuse a permit from another authenticated backend, even while its issuer is open', async () => {
    const f = await fixture(); await worker.begin(async tx => {
      await prepare(tx, f); await expect(peer.begin(p => p`select public.current_financial_application_manifest()`)).rejects.toThrow(/transaction\/backend/);
    });
  });
  it('savepoint rollback removes the permit and permits a fresh issuance in the top-level transaction', async () => {
    const f = await fixture(); await worker.begin(async tx => {
      let first: unknown;
      await expect(tx.savepoint(async nested => { first = (await prepare(nested, f))[0].id; throw new Error('savepoint rollback'); })).rejects.toThrow('savepoint rollback');
      await expect(tx.savepoint(nested => nested`select public.current_financial_application_manifest()`)).rejects.toThrow(/transaction\/backend/);
      const [second] = await prepare(tx, f); expect(second.id).not.toBe(first);
    });
  });
  it('rollback removes all preparation authority; retry keeps the same canonical root', async () => {
    const f = await fixture(); await expect(worker.begin(async tx => { await prepare(tx, f); throw new Error('planned rollback'); })).rejects.toThrow('planned rollback');
    expect(await h.db.sql`select 1 from financial_application_manifests where root_id=${f.rootId}`).toHaveLength(0);
    await worker.begin(tx => prepare(tx, f)); expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
  });
  it.each([['stale claim', 0, 1, 'refund.succeeded'], ['NULL/version0 proof', 1, 0, 'refund.succeeded'], ['wrong terminal outcome', 1, 1, 'refund.failed']] as const)
  ('rejects %s', async (_name, generation, revision, operation) => {
    const f = await fixture(); await expect(worker.begin(tx => prepare(tx, f, generation, revision, operation))).rejects.toThrow();
    expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
  });
  it('rejects a typed proof owned by another accepted operation', async () => {
    const a = await fixture(), b = await fixture(); await expect(worker.begin(tx => prepare(tx, { ...a, inboxId: b.inboxId }))).rejects.toThrow(/owner mismatch/);
  });
  it('one transaction cannot acquire a second operation permit', async () => {
    const a = await fixture(), b = await fixture(); await expect(worker.begin(async tx => { await prepare(tx, a); await prepare(tx, b); })).rejects.toThrow(/unique/);
    expect(await h.db.sql`select 1 from financial_application_manifests where root_id in (${a.rootId},${b.rootId})`).toHaveLength(0);
  });
  it.each(['financial_application_permits', 'financial_application_manifests', 'financial_application_roots', 'financial_application_contracts', 'financial_application_scope_authority', 'financial_applications', 'financial_application_dispositions'])
  ('ordinary LOGIN cannot directly insert trusted %s', async table => {
    await expect(worker.unsafe(`insert into public.${table} default values`)).rejects.toThrow(/permission denied/);
  });
  it('a caller UUID/JSON/session setting does not issue permission', async () => {
    await expect(worker.begin(async tx => { await tx`select set_config('app.financial_permit',${JSON.stringify({ id: randomUUID(), approved: true })},true)`;
      await tx`select public.complete_financial_application()`; })).rejects.toThrow(/transaction\/backend/);
  });
  it('canonical terminal identity cannot split success and failure into two roots', async () => {
    const f = await fixture(); await expect(h.db.sql`insert into financial_application_roots select gen_random_uuid(),family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,attempt_id,refund_id,dispute_id,settlement_id,payout_id,created_at from financial_application_roots where id=${f.rootId}`).rejects.toThrow(/unique/);
    expect(await h.db.sql`select 1 from financial_application_roots where operation_id=${f.operationId}`).toHaveLength(1);
  });
  it('rejects altered stored acceptance and provider ownership', async () => {
    const f = await fixture(); await expect(h.db.sql`insert into financial_application_roots(family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,refund_id)
      values('REFUND',${f.operationId},'TERMINAL',${f.merchantId},'USD','STRIPE',${f.account},'CAPTURE_FIFO_V1',1,${f.outboxId},${f.paymentId},${f.operationId})`).rejects.toThrow(/accepted command identity/);
  });
  it.each(['UNRECOGNIZED_FINANCIAL_TYPE', 'REFUND'])('protected journal %s cannot commit without a transaction application', async business => {
    const f = await fixture(); await expect(h.db.sql`insert into ledger_transactions(merchant_id,business_type,business_id,currency,description)
      values(${f.merchantId},${business},${f.operationId},'USD','structural forbidden write')`).rejects.toThrow(/transaction\/backend/);
    expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
  });
  it('version0 allocations and workflow writes cannot bypass an enrolled scope', async () => {
    const f = await fixture(); await expect(h.db.sql`update refund_capture_allocations set status=status,evidence_contract_version=0,proof_revision=null where refund_id=${f.operationId}`).rejects.toThrow(/transaction\/backend/);
    await expect(h.db.sql`update refunds set status='SUCCEEDED' where id=${f.operationId}`).rejects.toThrow(/transaction\/backend/);
  });
  it('a valid source-only permit cannot authorize an unprepared monetary/workflow write', async () => {
    const f = await fixture(); await expect(h.db.transaction(async tx => { await prepare(tx, f); await tx`update refunds set status='SUCCEEDED' where id=${f.operationId}`; })).rejects.toThrow(/SQL-prepared exact write/);
  });
  it('a SQL-prepared protected write still cannot COMMIT without its application', async () => {
    const f = await fixture();
    await h.db.sql`update r2a_structural_probe_plans set plan=jsonb_set(plan,'{effects}',
      (select jsonb_build_array(jsonb_build_object('table','refunds','id',r.id,'write','UPDATE','before',to_jsonb(r),'after',to_jsonb(r))) from refunds r where r.id=${f.operationId})) where root_id=${f.rootId}`;
    const before = (await h.db.sql`select to_jsonb(r) row from refunds r where id=${f.operationId}`)[0].row as unknown;
    await expect(h.db.transaction(async tx => { await prepare(tx, f); await tx`update refunds set status=status where id=${f.operationId}`; })).rejects.toThrow(/requires complete financial application/);
    expect((await h.db.sql`select to_jsonb(r) row from refunds r where id=${f.operationId}`)[0].row).toEqual(before);
    expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
  });
  it('completion refuses missing entire effects/audit manifests and preserves all source blockers', async () => {
    const f = await fixture(); await expect(worker.begin(async tx => { await prepare(tx, f); await tx`select public.complete_financial_application()`; })).rejects.toThrow(/Missing entire/);
    expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
    expect((await h.db.sql`select status from webhook_events where id=${f.inboxId}`)[0].status).toBe('PROCESSING');
    expect((await h.db.sql`select disposition from receipt_admission_obligations where inbox_id=${f.inboxId}`)[0].disposition).toBe('AWAITING_APPLICATION');
  });
  it('deferred COMMIT rejects an application/disposition with missing effects', async () => {
    const f = await fixture(); await expect(h.db.transaction(async tx => {
      const [m] = await prepare(tx, f); await tx`update webhook_events set status='PROCESSED' where id=${f.inboxId}`;
      await tx`insert into financial_applications(root_id,manifest_id,result,audit_id) values(${f.rootId},${String(m.id)},'ZERO_EFFECT',${f.auditId})`;
      await tx`insert into financial_application_dispositions(root_id,inbox_id,obligation_revision,disposition) select ${f.rootId},inbox_id,obligation_revision,'APPLIED' from receipt_admission_obligations where inbox_id=${f.inboxId}`;
    })).rejects.toThrow(/Missing entire/); expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
  });
  it('SET CONSTRAINTS ALL IMMEDIATE also rejects partial source disposition without an application', async () => {
    const f = await fixture(); await expect(h.db.transaction(async tx => {
      await prepare(tx, f); await tx`insert into financial_application_dispositions(root_id,observation_source_id,disposition) values(${f.rootId},${f.sourceId},'APPLIED')`;
      await tx`set constraints all immediate`;
    })).rejects.toThrow(/complete financial application|foreign key/); expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
  });
  it('legacy version0 behavior remains available outside protected enrollment', async () => {
    const f = await fixture(false); await h.db.sql`update refund_capture_allocations set status=status,evidence_contract_version=0,proof_revision=null where refund_id=${f.operationId}`;
    expect((await h.db.sql`select status,evidence_contract_version from refund_capture_allocations where refund_id=${f.operationId}`)[0]).toEqual({ status: 'RESERVED', evidence_contract_version: 0 });
  });
  it('rejects stale evidence revisions inside a transaction without retaining partial authority', async () => {
    const f = await fixture(); const owner = String((await h.db.sql`select 'fintech_admission_'||md5(current_database()) n`)[0].n);
    await expect(h.db.transaction(async tx => {
      await prepare(tx, f); await tx.unsafe(`set local role "${owner}"`);
      await tx`update capture_accounting_scopes set evidence_revision=evidence_revision+1 where merchant_id=${f.merchantId} and currency='USD'`;
      await tx`reset role`; await tx`select public.current_financial_application_manifest()`;
    })).rejects.toThrow(/Stale application/);
    expect(await h.db.sql`select 1 from financial_application_manifests where root_id=${f.rootId}`).toHaveLength(0);
  });
  it('retains a later contradictory D02 observation as an independent blocker', async () => {
    const f = await fixture(); await worker.begin(tx => prepare(tx, f));
    const transport = new ScriptedStripeHttp(() => ({ body: Buffer.from(JSON.stringify({ ...f.object, status: 'failed' })) }));
    const producer = new TrustedProviderObservations(h.publication, { account: f.account, mode: 'TEST', apiKey: 'sk_test_structural_probe', maxNetworkRetries: 0 }, transport);
    const [late] = await (await producer.execute(f.message)).publish();
    expect(late.id).not.toBe(f.sourceId);
    expect((await h.db.sql`select disposition from provider_observation_obligations where source_id=${late.id}`)[0].disposition).toBe('BLOCKING_REVIEW');
    await expect(worker.begin(tx => prepare(tx, f))).rejects.toThrow(/blocked/);
    expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
  });
  it('an exact-source disposition cannot consume another operation observation', async () => {
    const a = await fixture(), b = await fixture(); await expect(h.db.transaction(async tx => {
      await prepare(tx, a); await tx`insert into financial_application_dispositions(root_id,observation_source_id,disposition) values(${a.rootId},${b.sourceId},'APPLIED')`;
    })).rejects.toThrow(/Exact owned D02/);
    expect(await counts(a)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
  });
  it('application and evidence-only owners have no ledger DML or schema CREATE capability', async () => {
    const owners = await h.db.sql<{ rolname: string }[]>`select rolname from pg_roles where rolname in
      ('fintech_application_'||md5(current_database()),'fintech_admission_'||md5(current_database()),'fintech_observation_'||md5(current_database()),'fintech_evidence_'||md5(current_database()))`;
    expect(owners).toHaveLength(4);
    for (const { rolname } of owners) {
      expect((await h.db.sql`select has_table_privilege(${rolname},'ledger_transactions','INSERT,UPDATE,DELETE,TRUNCATE') w,
        has_any_column_privilege(${rolname},'ledger_transactions','INSERT,UPDATE') c,has_schema_privilege(${rolname},'public','CREATE') s`)[0]).toEqual({ w: false, c: false, s: false });
    }
    const leaked = await h.db.sql`select proname from pg_proc where pronamespace='public'::regnamespace and proname like '%financial_application%'
      and exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) where grantee=0 and privilege_type='EXECUTE')`;
    expect(leaked).toHaveLength(0);
  });
  it('serializes two permit issuers at their private wrapper with distinct observed backends', async () => {
    const f = await fixture(); let release!: () => void, ready!: () => void, waiting!: () => void, holder = 0, waiter = 0;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { ready = r; }), queued = new Promise<void>(r => { waiting = r; });
    const first = worker.begin(async tx => { holder = Number((await tx`select pg_backend_pid() p`)[0].p); await prepare(tx, f); ready(); await gate; });
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([started, first]); second = peer.begin(async tx => { waiter = Number((await tx`select pg_backend_pid() p`)[0].p); waiting(); return prepare(tx, f); }); await queued;
      expect(waiter).not.toBe(holder); let observed = false;
      for (let n = 0; n < 150; n++) { if ((await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) b`)[0].b) { observed = true; break; } await delay(20); }
      expect(observed).toBe(true); release(); await Promise.all([first, second]);
      expect(await h.db.sql`select 1 from financial_application_manifests where root_id=${f.rootId}`).toHaveLength(2);
      expect(await counts(f)).toEqual({ applications: 0, dispositions: 0, journals: 0 });
    } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
});
