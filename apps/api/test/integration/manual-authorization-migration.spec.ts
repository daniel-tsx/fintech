import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { providerObservationHarness } from '../support/provider-observation-harness';
import { publishCommandObservation, signedEvidence } from '../support/trusted-evidence-fixtures';

const describeMigration = process.env.RUN_DB_TESTS === '1' && process.env.RUN_MIGRATION_TESTS === '1' ? describe : describe.skip;
describeMigration('P-B atomic MANUAL authorization migration and legacy compatibility', () => {
  const folder = resolve(__dirname, '../../drizzle'), harnesses: Awaited<ReturnType<typeof providerObservationHarness>>[] = [];
  const functions = ['prepare_manual_authorization', 'apply_manual_authorization', 'recognize_manual_authorization',
    'claim_manual_authorization', 'fail_manual_authorization', 'validate_manual_authorization'];
  const closedTables = ['financial_application_contracts', 'financial_application_scope_authority', 'financial_application_roots',
    'financial_application_manifests', 'financial_application_permits', 'financial_applications', 'financial_application_dispositions',
    'financial_application_effect_links', 'financial_application_revision_effects'];

  function staged(count = 13, failure = false) {
    const target = resolve(__dirname, `../../../../.tmp/pb-migrations-${randomUUID()}`);
    mkdirSync(resolve(target, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(resolve(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter(e => e.idx < count);
    writeFileSync(resolve(target, 'meta/_journal.json'), JSON.stringify(journal));
    for (const e of journal.entries) copyFileSync(resolve(folder, e.tag + '.sql'), resolve(target, e.tag + '.sql'));
    if (failure) {
      const file = resolve(target, '0013_manual_authorization_application.sql');
      writeFileSync(file, readFileSync(file, 'utf8') + "\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'planned P-B rollback'; END $$;\n");
    }
    return target;
  }

  async function setup(source = folder) {
    const h = await providerObservationHarness(source); harnesses.push(h);
    const url = new URL(process.env.MIGRATION_ADMIN_URL!);
    url.pathname = '/' + String((await h.db.sql`select current_database() n`)[0].n);
    async function apply(from = folder) {
      const sql = postgres(url.toString(), { max: 1, connection: { statement_timeout: 10000 } });
      try { await migrate(drizzle(sql), { migrationsFolder: from }); } finally { await sql.end(); }
    }
    return { h, url, apply };
  }
  afterAll(async () => { for (const h of harnesses) await h.close(14); });

  async function data(sql: Sql, tables?: string[]) {
    const names = tables ?? (await sql<{ table_name: string }[]>`select table_name from information_schema.tables
      where table_schema='public' and table_type='BASE TABLE' order by table_name`).map(row => row.table_name);
    const result: Record<string, unknown> = {};
    for (const table of names) result[table] = await sql`select to_jsonb(t) as row from ${sql('public.' + table)} t order by to_jsonb(t)::text`;
    return result;
  }

  async function catalog(sql: Sql) {
    return {
      relations: await sql`select c.relname,c.relkind,r.rolname owner,c.relacl::text acl,c.relrowsecurity,c.relforcerowsecurity
        from pg_class c join pg_roles r on r.oid=c.relowner where c.relnamespace='public'::regnamespace order by c.relname`,
      columns: await sql`select c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,a.attgenerated,a.attacl::text acl,
        pg_get_expr(d.adbin,d.adrelid) default_expression from pg_attribute a join pg_class c on c.oid=a.attrelid
        left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where c.relnamespace='public'::regnamespace and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`,
      constraints: await sql`select c.relname,k.conname,pg_get_constraintdef(k.oid) definition from pg_constraint k
        join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace order by c.relname,k.conname`,
      indexes: await sql`select c.relname,pg_get_indexdef(c.oid) definition from pg_class c
        where c.relnamespace='public'::regnamespace and c.relkind in ('i','I') order by c.relname`,
      triggers: await sql`select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition from pg_trigger t
        join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by c.relname,t.tgname`,
      functions: await sql`select p.proname,pg_get_function_identity_arguments(p.oid) arguments,r.rolname owner,p.proacl::text acl,pg_get_functiondef(p.oid) definition
        from pg_proc p join pg_roles r on r.oid=p.proowner where p.pronamespace='public'::regnamespace order by p.proname,arguments`,
      schema: await sql`select n.nspname,r.rolname owner,n.nspacl::text acl from pg_namespace n join pg_roles r on r.oid=n.nspowner where n.nspname='public'`,
      defaults: await sql`select r.rolname owner,n.nspname,d.defaclobjtype,d.defaclacl::text acl from pg_default_acl d
        join pg_roles r on r.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace
        where n.nspname='public' or position(md5(current_database()) in r.rolname)>0 order by owner,n.nspname,d.defaclobjtype`,
      owners: await sql`select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig
        from pg_roles where position(md5(current_database()) in rolname)>0 order by rolname`,
      memberships: await sql`select r.rolname role,m.rolname member,g.rolname grantor,a.admin_option from pg_auth_members a
        join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor
        where position(md5(current_database()) in r.rolname)>0 or position(md5(current_database()) in m.rolname)>0 order by role,member,grantor`,
    };
  }

  async function legacy(h: Awaited<ReturnType<typeof providerObservationHarness>>) {
    const f = await h.accepted();
    await h.db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
    await (await f.producer.execute(f.message)).publish();
    await h.db.sql`insert into refund_capture_allocations(refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross)
      values(${f.operationId},${f.lotId},${f.paymentId},${f.merchantId},'USD',2000)`;
    const signed = signedEvidence({ ...f, refundId: f.operationId, objectId: f.object.id }, { object: { amount: 2000 } }), attested = h.sign(signed.raw);
    const receipt = await h.receiver(f.account).receive(attested.raw, attested.signature);
    expect(await h.correlate(f.account).correlate(receipt.id)).toMatchObject({ state: 'BOUND' });
    const [root] = await h.db.sql<{ id: string }[]>`insert into financial_application_roots(family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,refund_id)
      values('REFUND',${f.operationId},'TERMINAL',${f.merchantId},'USD','STRIPE',${f.account},'LEGACY',0,${f.outboxId},${f.paymentId},${f.operationId}) returning id`;
    function insert(inbox = receipt.id) {
      return h.db.sql`insert into financial_application_manifests(root_id,transaction_id,backend_pid,inbox_id,proof_revision,proof_operation,claim_generation,merchant_id,currency,payment_id,
        policy,epoch,scope_revision,intake_revision,contract_version,result,source_manifest,effect_manifest)
        values(${root.id},pg_current_xact_id(),pg_backend_pid(),${inbox},1,'refund.succeeded',0,${f.merchantId},'USD',${f.paymentId},
          'LEGACY',0,0,0,1,'ZERO_EFFECT','{}','[]') returning id`;
    }
    const [manifest] = await insert();
    return { ...f, inboxId: receipt.id, manifestId: String(manifest.id), insert };
  }

  it('fresh fourteen-migration install is repeatable, empty and closed', async () => {
    const { h, apply } = await setup(); await apply(); await apply();
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(14);
    for (const table of closedTables) expect(await h.db.sql`select 1 from ${h.db.sql('public.' + table)}`).toHaveLength(0);
    expect(await h.db.sql`select 1 from capture_accounting_scopes where status='ACTIVE'`).toHaveLength(0);
    expect(await h.db.sql`select 1 from financial_evidence_accounts where runtime_enforcement<>'UNINSTALLED'`).toHaveLength(0);
  }, 30000);

  it('installs only restricted NOLOGIN owners and pinned functions without PUBLIC or runtime LOGIN grants', async () => {
    const { h } = await setup();
    const owners = await h.db.sql`select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
      from pg_roles where rolname like 'fintech_manual_%'||md5(current_database()) order by rolname`;
    for (const prefix of ['fintech_manual_authorization_', 'fintech_manual_claim_', 'fintech_manual_history_']) {
      expect(owners.some(owner => String(owner.rolname).startsWith(prefix))).toBe(true);
    }
    for (const owner of owners) expect(owner).toMatchObject({ rolcanlogin: false, rolinherit: false, rolsuper: false,
      rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect(await h.db.sql`select 1 from pg_auth_members a join pg_roles r on r.oid=a.roleid
      where r.rolname like 'fintech_manual_%'||md5(current_database())`).toHaveLength(0);
    const rights = await h.db.sql`select p.proname,p.proconfig,r.rolname owner,p.prosecdef,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE') public_execute,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x join pg_roles grantee on grantee.oid=x.grantee
        where grantee.rolcanlogin and x.privilege_type='EXECUTE') login_execute
      from pg_proc p join pg_roles r on r.oid=p.proowner where p.pronamespace='public'::regnamespace
        and (p.proname like '%manual_authorization%' or r.rolname like 'fintech_manual_%'||md5(current_database())) order by p.proname`;
    for (const name of functions) {
      const selected = rights.filter(right => right.proname === name); expect(selected).toHaveLength(1);
      expect(selected[0].prosecdef).toBe(true);
    }
    for (const right of rights) {
      expect(right.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(right.public_execute).toBe(false); expect(right.login_execute).toBe(false);
    }
    for (const owner of owners) {
      const [privileges] = await h.db.sql`select has_schema_privilege(${String(owner.rolname)},'public','CREATE') schema_create,
        has_table_privilege(${String(owner.rolname)},'public.financial_application_contracts','INSERT') contract_insert,
        has_table_privilege(${String(owner.rolname)},'public.financial_application_scope_authority','INSERT') enrollment_insert,
        has_table_privilege(${String(owner.rolname)},'public.payments','UPDATE') payment_table_update,
        has_table_privilege(${String(owner.rolname)},'public.payment_attempts','UPDATE') attempt_table_update`;
      expect(privileges).toEqual({ schema_create: false, contract_insert: false, enrollment_insert: false,
        payment_table_update: false, attempt_table_update: false });
    }
  }, 30000);

  it('populated0012 upgrade preserves every original record and REFUND proof, reader, FK and structural probes', async () => {
    const { h, apply } = await setup(staged()), f = await legacy(h);
    const before = await data(h.db.sql), facts: unknown = (await h.db.sql`select public.receipt_admission_facts(${f.inboxId}) f`)[0].f;
    await apply(); await apply();
    expect(await data(h.db.sql, Object.keys(before))).toEqual(before);
    expect((await h.db.sql`select public.receipt_admission_facts(${f.inboxId}) f`)[0].f).toEqual(facts);
    expect((await h.db.sql`select proof_kind,legacy_proof_inbox_id,payment_proof_inbox_id,payment_operation_proof_id from financial_application_manifests where id=${f.manifestId}`)[0])
      .toEqual({ proof_kind: 'REFUND_V1', legacy_proof_inbox_id: f.inboxId, payment_proof_inbox_id: null, payment_operation_proof_id: null });
    await f.insert();
    await expect(f.insert(randomUUID())).rejects.toMatchObject({ code: '23503' });
    await expect(h.db.sql`update financial_application_manifests set proof_kind=proof_kind where id=${f.manifestId}`).rejects.toThrow(/immutable/i);
    await expect(h.db.sql`update ledger_entries set debit=debit where transaction_id=${f.journalId}`).rejects.toThrow(/immutable/i);
    expect(await h.correlate(f.account).correlate(f.inboxId)).toMatchObject({ state: 'BOUND' });
    expect(await h.db.sql`select 1 from financial_application_scope_authority`).toHaveLength(0);
    expect(await h.db.sql`select 1 from financial_application_contracts`).toHaveLength(0);
  }, 30000);

  it('late0013 failure restores catalog, ACLs, owners and all data before a successful retry', async () => {
    const { h, apply } = await setup(staged()); await legacy(h);
    const before = await data(h.db.sql), originalCatalog = await catalog(h.db.sql); let error: unknown;
    try { await apply(staged(14, true)); } catch (e) { error = e; }
    expect((error as { cause: Error }).cause.message).toMatch(/planned P-B rollback/);
    expect(await data(h.db.sql)).toEqual(before); expect(await catalog(h.db.sql)).toEqual(originalCatalog);
    expect(await h.db.sql`select 1 from pg_proc where pronamespace='public'::regnamespace and proname=any(${functions})`).toHaveLength(0);
    expect(await h.db.sql`select 1 from pg_roles where rolname like 'fintech_manual_%'||md5(current_database())`).toHaveLength(0);
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(13);
    await apply();
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(14);
    expect(await data(h.db.sql, Object.keys(before))).toEqual(before);
  }, 30000);

  it('observes affected DDL waiting on a distinct root writer without exposing partial AUTH authority', async () => {
    const { h, url, apply } = await setup(staged()); await legacy(h);
    let release!: () => void, ready!: () => void, holder = 0;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { ready = r; });
    const first = h.db.transaction(async tx => {
      holder = Number((await tx`select pg_backend_pid() p`)[0].p);
      await tx`lock table public.financial_application_roots in row exclusive mode`; ready(); await gate;
    });
    const sql = postgres(url.toString(), { max: 1, connection: { statement_timeout: 10000 } }); let pending: Promise<void> | undefined;
    try {
      await Promise.race([started, first]); const waiter = Number((await sql`select pg_backend_pid() p`)[0].p); expect(waiter).not.toBe(holder);
      pending = migrate(drizzle(sql), { migrationsFolder: folder }); let observed = false;
      for (let n = 0; n < 150; n++) {
        if ((await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) b`)[0].b) { observed = true; break; }
        await delay(20);
      }
      expect(observed).toBe(true);
      expect(await h.db.sql`select 1 from pg_proc where pronamespace='public'::regnamespace and proname=any(${functions})`).toHaveLength(0);
      expect(await h.db.sql`select 1 from pg_roles where rolname like 'fintech_manual_%'||md5(current_database())`).toHaveLength(0);
      expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(13);
      for (const table of ['financial_application_contracts', 'financial_application_scope_authority', 'financial_application_permits'])
        expect(await h.db.sql`select 1 from ${h.db.sql('public.' + table)}`).toHaveLength(0);
      release(); await Promise.all([first, pending]); await apply();
      expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(14);
    } finally { release(); await Promise.allSettled([first, ...(pending ? [pending] : [])]); await sql.end(); }
  }, 30000);
});
