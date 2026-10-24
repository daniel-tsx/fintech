import { randomBytes, randomUUID } from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { paymentOperationHarness } from '../support/payment-operation-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Row = Record<string, string | number | null>;
// A raw INSERT here proves inert storage only; it is never a P-B application.
async function insert(sql: Sql | TransactionSql, row: Row) {
  const keys = Object.keys(row);
  return sql.unsafe<{id:string}[]>(`insert into financial_application_manifests(transaction_id,backend_pid,${keys.join(',')})
    values(pg_current_xact_id(),pg_backend_pid(),${keys.map((key, i) => '$' + (i + 1) + (key.endsWith('_manifest') ? '::text::jsonb' : '')).join(',')}) returning id`, Object.values(row));
}
describeDb('P-A shared immutable payment proof envelope', () => {
  let h: Awaited<ReturnType<typeof paymentOperationHarness>>, structural: Sql, columns: Sql, ordinary: Sql;
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  let f: Fixture, foreign: Fixture;
  async function fixture(operation: 'CAPTURE' | 'AUTHORIZE' | 'VOID' = 'CAPTURE') {
    const value = await h.fixture({ operation }), sealed = await value.seal(); expect(sealed.state).toBe('SEALED');
    await h.evidence.bind(value.inboxId, sealed.proof_id!, '0');
    const [root] = await h.db.sql`insert into financial_application_roots
      (family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,attempt_id)
      values(${operation},${value.accepted.id},'TERMINAL',${value.merchantId},'USD','STRIPE',${value.account},'LEGACY',0,${value.accepted.outboxId},${value.paymentId},${value.accepted.id}) returning id`;
    return { ...value, proofId: sealed.proof_id!, rootId: String(root.id) };
  }
  function row(value = f): Row {
    return { root_id: value.rootId, inbox_id: value.inboxId, proof_kind: 'PAYMENT_OPERATION_V1', payment_operation_proof_id: value.proofId,
      proof_revision: 1, proof_operation: value.operation === 'CAPTURE' ? 'payment.capture_succeeded' : value.operation === 'AUTHORIZE' ? 'payment.authorized' : 'payment.cancelled', claim_generation: 0,
      merchant_id: value.merchantId, currency: 'USD', payment_id: value.paymentId, policy: 'LEGACY', epoch: 0, scope_revision: 0, intake_revision: 0,
      contract_version: 1, result: 'VERIFIED_NO_EFFECT', source_manifest: '{}', effect_manifest: '[]' };
  }
  beforeAll(async () => {
    h = await paymentOperationHarness(); f = await fixture(); foreign = await fixture();
    async function login(label: string) {
      const role = `pa_${label}_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
      await h.db.sql.unsafe(`create role "${role}" login password '${password}' noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
      await h.db.sql.unsafe(`grant usage on schema public to "${role}"`);
      const url = new URL(process.env.MIGRATION_ADMIN_URL!); url.pathname = '/' + String((await h.db.sql`select current_database() n`)[0].n); url.username = role; url.password = password;
      return { role, sql: postgres(url.toString(), { max: 1, connection: { statement_timeout: 10000 } }) };
    }
    const storage = await login('structural'); structural = storage.sql;
    const column = await login('columns'); columns = column.sql; ordinary = (await login('ordinary')).sql;
    await h.db.sql.unsafe(`grant insert,select(id) on financial_application_manifests to "${storage.role}"`);
    await h.db.sql.unsafe(`grant insert(proof_kind,payment_operation_proof_id),select(id) on financial_application_manifests to "${column.role}"`);
  }, 30000);
  afterAll(async () => { for (const sql of [structural, columns, ordinary]) if (sql) await sql.end(); if (h) await h.close(); });
  async function closed() {
    for (const table of ['financial_application_contracts','financial_application_scope_authority','financial_application_permits','financial_applications','financial_application_dispositions','financial_application_revision_effects','ledger_transactions','capture_accounting_lots'])
      expect(await h.db.sql.unsafe(`select 1 from ${table}`)).toHaveLength(0);
    expect(await h.db.sql`select 1 from capture_accounting_scopes where status='ACTIVE'`).toHaveLength(0);
    expect((await h.db.sql`select captured_amount::text from payments where id=${f.paymentId}`)[0].captured_amount).toBe('0');
    expect((await h.db.sql`select status from payment_attempts where id=${f.accepted.id}`)[0].status).toBe('PENDING');
    expect((await h.db.sql`select disposition from receipt_admission_obligations where inbox_id=${f.inboxId}`)[0].disposition).toBe('AWAITING_APPLICATION');
  }
  it('stores genuine sealed/bound B1 CAPTURE through a separate structural LOGIN without application authority', async () => {
    const [id] = await insert(structural, row());
    expect((await h.db.sql`select proof_kind,legacy_proof_inbox_id,payment_proof_inbox_id,payment_operation_proof_id from financial_application_manifests where id=${id.id}`)[0])
      .toEqual({ proof_kind:'PAYMENT_OPERATION_V1', legacy_proof_inbox_id:null, payment_proof_inbox_id:f.inboxId, payment_operation_proof_id:f.proofId });
    await closed();
  });
  it.each(['AUTHORIZE','VOID'] as const)('retains %s typed storage without opening workflow finality', async operation => {
    const value = await fixture(operation); await insert(structural, row(value)); await closed();
  });
  it.each([
    ['null tag',{proof_kind:null}], ['invalid tag',{proof_kind:'CAPTURE'}], ['both branches',{proof_kind:'REFUND_V1'}],
    ['no proof',{payment_operation_proof_id:null}], ['missing proof',{payment_operation_proof_id:randomUUID()}],
    ['null inbox',{inbox_id:null}], ['null revision',{proof_revision:null}], ['wrong revision',{proof_revision:2}],
    ['null owner',{payment_id:null}], ['wrong merchant',{merchant_id:randomUUID()}], ['wrong payment',{payment_id:randomUUID()}],
    ['wrong currency',{currency:'EUR'}], ['wrong operation',{proof_operation:'payment.authorized'}],
    ['wrong policy',{policy:'CAPTURE_FIFO_V1'}], ['wrong epoch',{epoch:1}],
    ['caller legacy link',{legacy_proof_inbox_id:randomUUID()}], ['caller payment link',{payment_proof_inbox_id:randomUUID()}],
  ] as [string, Row][])('rejects %s atomically', async (_name, override) => {
    const before = (await h.db.sql<{n:number}[]>`select count(*)::int n from financial_application_manifests`)[0].n;
    await expect(insert(structural, { ...row(), ...override })).rejects.toMatchObject({ code: expect.any(String) as string });
    expect((await h.db.sql`select count(*)::int n from financial_application_manifests`)[0].n).toBe(before); await closed();
  });
  it('rejects foreign inbox/proof/root tuples even with the same operation', async () => {
    for (const override of [{ inbox_id:foreign.inboxId }, { payment_operation_proof_id:foreign.proofId }, { root_id:foreign.rootId },
      { inbox_id:foreign.inboxId,payment_operation_proof_id:foreign.proofId }] as Row[])
      await expect(insert(structural, { ...row(), ...override })).rejects.toThrow();
    await closed();
  });
  it('checks canonical attempt/outbox/family and refuses the default REFUND tag on payment roots', async () => {
    const [root] = await h.db.sql`insert into financial_application_roots
      (family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,attempt_id)
      values('AUTHORIZE',${f.auth.id},'TERMINAL',${f.merchantId},'USD','STRIPE',${f.account},'LEGACY',0,${f.auth.outboxId},${f.paymentId},${f.auth.id}) returning id`;
    await expect(insert(structural, { ...row(),root_id:String(root.id) })).rejects.toThrow(/canonical root/);
    const legacy = row(); delete legacy.proof_kind; delete legacy.payment_operation_proof_id;
    await expect(insert(structural, legacy)).rejects.toThrow(/REFUND root/);
  });
  it.each(['outcome','mode','account','source','execution','fingerprint','source facts','authorization facts','command hash','receipt hash'] as const)('rejects a forged %s before a deferred B1 seal can commit', async kind => {
    const unsealed = await h.fixture(), id = randomUUID();
    await expect(h.db.transaction(async tx => {
      const [proof] = await tx`select to_jsonb(e)-'id'-'inbox_id' original from payment_operation_evidence e where id=${f.proofId}`;
      const fake: Record<string, unknown> = { ...proof.original as Record<string, unknown>, id, inbox_id:unsealed.inboxId };
      if (kind === 'outcome') Object.assign(fake,{operation:'payment.authorized',outcome:'AUTHORIZE_SUCCEEDED',capture_principal:null,authorized_principal:10000,authorization_source_id:null});
      if (kind === 'mode') fake.provider_mode='LIVE';
      if (kind === 'account') fake.provider_account=foreign.account;
      if (kind === 'source') fake.source_id=foreign.sourceId;
      if (kind === 'execution') fake.execution_id=randomUUID();
      if (kind === 'fingerprint') fake.fingerprint='\\x'+'00'.repeat(32);
      if (kind.endsWith('facts') || kind.endsWith('hash')) {
        const facts = fake.facts as Record<string, unknown>;
        if (kind === 'source facts') facts.source={...facts.source as object,source_fingerprint:'00'.repeat(32)};
        if (kind === 'authorization facts') facts.authorization={...facts.authorization as object,source_id:foreign.authSource};
        if (kind === 'command hash') facts.command_hash='00'.repeat(32);
        if (kind === 'receipt hash') facts.receipt_hash='00'.repeat(32);
        const [hash] = await tx`select '\\x'||encode(sha256(convert_to((${JSON.stringify(facts)}::text::jsonb)::text,'UTF8')),'hex') digest`;
        fake.fingerprint=hash.digest;
      }
      await tx`insert into payment_operation_evidence select * from jsonb_populate_record(null::payment_operation_evidence,${JSON.stringify(fake)}::text::jsonb)`;
      await insert(tx,{...row(),inbox_id:unsealed.inboxId,payment_operation_proof_id:id});
      throw new Error('forged proof unexpectedly accepted');
    })).rejects.toMatchObject({code:kind==='source'||kind==='execution'?'23503':'P0001'});
    expect(await h.db.sql`select 1 from payment_operation_evidence where id=${id}`).toHaveLength(0); await closed();
  });
  it('keeps manifests and original proof/source/execution history immutable including TRUNCATE', async () => {
    for (const table of ['financial_application_manifests','payment_operation_evidence','provider_observation_sources','provider_command_executions']) {
      await expect(h.db.sql.unsafe(`update ${table} set id=id`)).rejects.toThrow(/immutable/i);
      await expect(h.db.sql.unsafe(`delete from ${table}`)).rejects.toThrow(/immutable/i);
      await expect(h.db.sql.unsafe(`truncate ${table} cascade`)).rejects.toThrow(/immutable|truncat/i);
    }
  });
  it('rolls back storage after immediate constraint validation without permits or source clearance', async () => {
    const before = (await h.db.sql<{n:number}[]>`select count(*)::int n from financial_application_manifests`)[0].n;
    await expect(structural.begin(async tx => { await insert(tx,row()); await tx`set constraints all immediate`; throw new Error('late storage rollback'); })).rejects.toThrow('late storage rollback');
    expect((await h.db.sql`select count(*)::int n from financial_application_manifests`)[0].n).toBe(before); await closed();
  });
  it('retains deferred financial group rejection for an inert manifest', async () => {
    await expect(h.db.transaction(async tx => {
      const [m] = await insert(tx,row());
      await tx`insert into financial_application_revision_effects(manifest_id,root_id,prior_revision,final_revision) values(${m.id},${f.rootId},0,1)`;
      await tx`set constraints all immediate`;
    })).rejects.toThrow(); await closed();
  });
  it('denies ordinary and column-only LOGIN writes and direct protected checker calls', async () => {
    await expect(insert(ordinary,row())).rejects.toMatchObject({code:'42501'});
    await expect(insert(columns,row())).rejects.toMatchObject({code:'42501'});
    await expect(columns`insert into financial_application_manifests(proof_kind,payment_operation_proof_id) values('PAYMENT_OPERATION_V1',${f.proofId})`).rejects.toThrow();
    for (const sql of [ordinary,columns,structural]) await expect(sql`select public.check_payment_proof_envelope()`).rejects.toMatchObject({code:'42501'});
    await expect(structural`select public.current_financial_application_manifest()`).rejects.toMatchObject({code:'42501'}); await closed();
  });
  it('uses a SELECT-only NOLOGIN owner with pinned search path and no PUBLIC execute/schema CREATE', async () => {
    const [owner] = await h.db.sql<{rolname:string}[]>`select r.rolname,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,p.proconfig,
      has_schema_privilege(r.oid,'public','CREATE') create_schema,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') public_execute
      from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid='public.check_payment_proof_envelope()'::regprocedure`;
    expect(owner).toMatchObject({rolcanlogin:false,rolinherit:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,
      proconfig:['search_path=pg_catalog, pg_temp'],create_schema:false,public_execute:false});
    expect(await h.db.sql`select 1 from information_schema.role_table_grants where grantee=${owner.rolname} and privilege_type<>'SELECT'`).toHaveLength(0);
    expect(await h.db.sql`select 1 from information_schema.column_privileges where grantee=${owner.rolname} and privilege_type<>'SELECT'`).toHaveLength(0);
    expect(await h.db.sql`select 1 from pg_auth_members where roleid=(select oid from pg_roles where rolname=${owner.rolname})`).toHaveLength(0);
  });
  it('refuses AUTHORIZE/CAPTURE/VOID preparation even with a registered private probe', async () => {
    await h.db.sql`create function public.pa_closed_prepare(uuid) returns jsonb language sql as 'select ''{}''::jsonb'`;
    await h.db.sql`create function public.pa_closed_validate(uuid) returns boolean language sql as 'select false'`;
    for (const operation of ['AUTHORIZE','CAPTURE','VOID'] as const) {
      const value = await fixture(operation);
      await h.db.sql`insert into financial_application_contracts values(${operation},'TERMINAL','LEGACY',1,'public.pa_closed_prepare(uuid)'::regprocedure,'public.pa_closed_validate(uuid)'::regprocedure)`;
      await expect(h.db.transaction(async tx => {
        await tx`insert into financial_application_scope_authority values(${value.merchantId},'USD','STRIPE',${value.account},'LEGACY',0,'DORMANT')`;
        await tx`update webhook_events set status='PROCESSING' where id=${value.inboxId}`;
        await tx`select public.prepare_financial_application(${value.rootId},${value.inboxId},0,1,${row(value).proof_operation})`;
      })).rejects.toThrow(/Typed application proof contract is not installed/);
    }
    expect(await h.db.sql`select 1 from financial_application_permits`).toHaveLength(0);
    expect(await h.db.sql`select 1 from financial_applications`).toHaveLength(0);
  });
});
