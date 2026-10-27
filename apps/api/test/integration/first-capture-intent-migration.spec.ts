import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { manualAuthorizationHarness } from '../support/manual-authorization-harness';
import { publishCommandObservation, signedEvidence } from '../support/trusted-evidence-fixtures';

const describeMigration = process.env.RUN_DB_TESTS === '1' && process.env.RUN_MIGRATION_TESTS === '1' ? describe : describe.skip;
describeMigration('P-C atomic protected capture-intent migration', () => {
  const folder = resolve(__dirname, '../../drizzle');
  const harnesses: Awaited<ReturnType<typeof manualAuthorizationHarness>>[] = [];
  const tables = ['first_capture_intent_requests', 'first_capture_intent_manifests', 'first_capture_intent_acceptances'];
  const entryPoints = ['prepare_first_capture_intent', 'apply_first_capture_intent', 'accept_first_capture_intent'];
  function staged(count: number, failure = false) {
    const target = resolve(__dirname, `../../../../.tmp/pc-migrations-${randomUUID()}`);
    mkdirSync(resolve(target, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(resolve(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter(e => e.idx < count);
    writeFileSync(resolve(target, 'meta/_journal.json'), JSON.stringify(journal));
    for (const e of journal.entries) copyFileSync(resolve(folder, e.tag + '.sql'), resolve(target, e.tag + '.sql'));
    if (failure) {
      const last = journal.entries.at(-1)!;
      const path = resolve(target, last.tag + '.sql');
      writeFileSync(path, readFileSync(path, 'utf8') + "\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'planned P-C rollback'; END $$;\n");
    }
    return target;
  }
  async function setup(source = folder) {
    const h = await manualAuthorizationHarness(source); harnesses.push(h);
    const url = new URL(process.env.MIGRATION_ADMIN_URL!);
    url.pathname = '/' + String((await h.db.sql`select current_database() n`)[0].n);
    async function apply(from = folder) {
      const sql = postgres(url.toString(), { max: 1, connection: { statement_timeout: 10000 } });
      try { await migrate(drizzle(sql), { migrationsFolder: from }); } finally { await sql.end(); }
    }
    return { h, url, apply };
  }
  afterAll(async () => { for (const h of harnesses) await h.close(15); });
  async function data(sql: Sql, names?: string[]) {
    const selected = names ?? (await sql<{ name: string }[]>`select tablename name from pg_tables where schemaname='public' order by tablename`).map(r => r.name);
    const rows: Record<string, unknown> = {};
    for (const name of selected) rows[name] = await sql`select to_jsonb(t) row from ${sql('public.' + name)} t order by to_jsonb(t)::text`;
    return rows;
  }
  async function catalog(sql: Sql) {
    return {
      columns: await sql`select c.relname,a.attname,a.attnotnull,a.attacl::text,pg_get_expr(d.adbin,d.adrelid) default_expression
        from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where c.relnamespace='public'::regnamespace and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`,
      constraints: await sql<{ relname: string; conname: string; definition: string }[]>`select c.relname,k.conname,pg_get_constraintdef(k.oid) definition from pg_constraint k
        join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace order by c.relname,k.conname`,
      functions: await sql<{ oid: number; proname: string; proowner: number; proacl: string | null; definition: string }[]>`select p.oid,p.proname,p.proowner,p.proacl::text,pg_get_functiondef(p.oid) definition
        from pg_proc p where p.pronamespace='public'::regnamespace order by p.oid`,
      commandGrants: await sql`select x.* from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
        where p.pronamespace='public'::regnamespace and p.proname='accept_provider_command' order by x.grantee,x.grantor`,
      relations: await sql`select relname,relowner,relacl::text from pg_class where relnamespace='public'::regnamespace order by relname`,
      owners: await sql`select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
        from pg_roles where position(md5(current_database()) in rolname)>0 order by rolname`,
      schema: await sql`select nspacl::text from pg_namespace where nspname='public'`,
    };
  }
  async function legacyRefund(h: Awaited<ReturnType<typeof manualAuthorizationHarness>>) {
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
  it('fresh fifteen-migration install repeats without installing a contract, enrollment or runtime grant', async () => {
    const { h, apply } = await setup(); await apply(); await apply();
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(15);
    for (const table of [...tables, 'financial_application_contracts', 'financial_application_scope_authority', 'financial_application_permits'])
      expect(await h.db.sql`select 1 from ${h.db.sql('public.' + table)}`).toHaveLength(0);
    expect(await h.db.sql`select 1 from capture_accounting_scopes where status='ACTIVE'`).toHaveLength(0);
    expect(await h.db.sql`select 1 from financial_evidence_accounts where runtime_enforcement<>'UNINSTALLED'`).toHaveLength(0);
    const rights = await h.db.sql`select p.proname,p.proconfig,p.prosecdef,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE') public_execute,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x join pg_roles r on r.oid=x.grantee where r.rolcanlogin and x.privilege_type='EXECUTE') login_execute
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=any(${entryPoints})`;
    expect(rights).toHaveLength(entryPoints.length);
    for (const right of rights) expect(right).toMatchObject({ proconfig: ['search_path=pg_catalog, pg_temp'], prosecdef: true, public_execute: false, login_execute: false });
    const owners = await h.db.sql<{ rolname: string; rolcanlogin: boolean; rolinherit: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean }[]>`
      select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles
      where rolname in('fintech_capture_intent_'||md5(current_database()),'fintech_capture_check_'||md5(current_database()))`;
    expect(owners).toHaveLength(2);
    for (const owner of owners) {
      expect(owner).toMatchObject({ rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect(await h.db.sql`select 1 from pg_auth_members a join pg_roles r on r.oid=a.roleid where r.rolname=${owner.rolname}`).toHaveLength(0);
      const [privileges] = await h.db.sql`select has_schema_privilege(${owner.rolname},'public','CREATE') schema_create,
        has_table_privilege(${owner.rolname},'public.financial_application_contracts','INSERT') contract_insert,
        has_table_privilege(${owner.rolname},'public.financial_application_scope_authority','INSERT') scope_insert,
        has_table_privilege(${owner.rolname},'public.ledger_transactions','INSERT') journal_insert,
        has_table_privilege(${owner.rolname},'public.ledger_entries','INSERT') entry_insert,
        has_table_privilege(${owner.rolname},'public.payments','UPDATE') payment_table_update`;
      expect(privileges).toEqual({ schema_create: false, contract_insert: false, scope_insert: false, journal_insert: false, entry_insert: false, payment_table_update: false });
    }
  }, 30000);
  it('populated0013 upgrade preserves real P-B authority, APPLICATION permits, historical functions and all original rows', async () => {
    const { h, apply } = await setup(staged(14)); await h.install();
    const f = await h.fixture(), [root] = await h.complete(f), refund = await legacyRefund(h);
    const before = await data(h.db.sql), oldCatalog = await catalog(h.db.sql);
    expect((await h.db.sql`select public.manual_authorization_history(${root.id}) valid`)[0].valid).toBe(true);
    await apply(); await apply();
    const after = await data(h.db.sql, Object.keys(before));
    // Only the additive permit representation changes; its old values stay exact.
    after.financial_application_permits = (after.financial_application_permits as { row: Record<string, unknown> }[]).map(({ row }) => {
      expect(row.permit_kind).toBe('APPLICATION'); expect(row.intent_manifest_id).toBeNull();
      const { permit_kind: _kind, intent_manifest_id: _intent, ...original } = row;
      void _kind; void _intent; return { row: original };
    });
    expect(after).toEqual(before);
    const preserved = oldCatalog.functions
      .filter(fn => ['guard_financial_application_effect', 'check_financial_application_effect_finality', 'guard_manual_authorization_authority',
        'check_manual_authorization_finality', 'current_financial_application_manifest', 'accept_provider_command'].includes(fn.proname));
    const current = await catalog(h.db.sql);
    for (const original of preserved) expect(current.functions).toEqual(expect.arrayContaining([expect.objectContaining({ oid: original.oid,
      proname: original.proname, proowner: original.proowner,
      ...(original.proname === 'accept_provider_command' ? { definition: original.definition } : { proacl: original.proacl }) })]));
    expect(current.commandGrants).toEqual(expect.arrayContaining([...oldCatalog.commandGrants]));
    const additions = current.commandGrants.filter(grant => !oldCatalog.commandGrants.some(old => JSON.stringify(old) === JSON.stringify(grant)));
    const [issuer] = await h.db.sql<{ oid: number }[]>`select oid from pg_roles where rolname='fintech_capture_intent_'||md5(current_database())`;
    expect(additions).toEqual([expect.objectContaining({ grantee: issuer.oid, privilege_type: 'EXECUTE', is_grantable: false })]);
    expect((await h.db.sql`select public.manual_authorization_history(${root.id}) valid`)[0].valid).toBe(true);
    expect((await h.recognize(f))[0].id).toBe(root.id);
    expect((await h.db.sql`select proof_kind,legacy_proof_inbox_id,payment_proof_inbox_id from financial_application_manifests where id=${refund.manifestId}`)[0])
      .toEqual({ proof_kind: 'REFUND_V1', legacy_proof_inbox_id: refund.inboxId, payment_proof_inbox_id: null });
    await refund.insert();
    await expect(refund.insert(randomUUID())).rejects.toMatchObject({ code: '23503' });
    expect(await h.correlate(refund.account).correlate(refund.inboxId)).toMatchObject({ state: 'BOUND' });
    expect(await h.db.sql`select 1 from financial_application_permits where permit_kind='CAPTURE_INTENT'`).toHaveLength(0);
    const authFk = oldCatalog.constraints.filter(c => c.conname.includes('manifest') && c.conname.includes('fkey'));
    for (const constraint of authFk) expect(current.constraints).toEqual(expect.arrayContaining([constraint]));
  }, 30000);
  it('late0014 failure rolls back the complete catalog, role rights and data before retry', async () => {
    const { h, apply } = await setup(staged(14)); await h.install(); const f = await h.fixture(); await h.complete(f);
    const before = await data(h.db.sql), oldCatalog = await catalog(h.db.sql);
    let error: unknown; try { await apply(staged(15, true)); } catch (e) { error = e; }
    expect((error as { cause: Error }).cause.message).toMatch('planned P-C rollback');
    expect(await data(h.db.sql)).toEqual(before); expect(await catalog(h.db.sql)).toEqual(oldCatalog);
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(14);
    await apply(); expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(15);
  }, 30000);
  it('waits on the affected permit table and exposes no partial capture capability before atomic commit', async () => {
    const { h, url, apply } = await setup(staged(14));
    let release!: () => void, ready!: () => void, holder = 0;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { ready = r; });
    const first = h.db.transaction(async tx => {
      holder = Number((await tx`select pg_backend_pid() p`)[0].p);
      await tx`lock table public.financial_application_permits in row exclusive mode`; ready(); await gate;
    });
    const sql = postgres(url.toString(), { max: 1, connection: { statement_timeout: 10000 } }); let pending: Promise<void> | undefined;
    try {
      await Promise.race([started, first]); const waiter = Number((await sql`select pg_backend_pid() p`)[0].p); expect(waiter).not.toBe(holder);
      pending = migrate(drizzle(sql), { migrationsFolder: folder }); let observed = false;
      for (let n = 0; n < 150; n++) {
        if ((await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) b`)[0].b) { observed = true; break; } await delay(20);
      }
      expect(observed).toBe(true);
      expect(await h.db.sql`select 1 from pg_proc where pronamespace='public'::regnamespace and proname=any(${entryPoints})`).toHaveLength(0);
      expect(await h.db.sql`select 1 from pg_tables where schemaname='public' and tablename=any(${tables})`).toHaveLength(0);
      expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(14);
      release(); await Promise.all([first, pending]); await apply();
      expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(15);
    } finally { release(); await Promise.allSettled([first, ...(pending ? [pending] : [])]); await sql.end(); }
  }, 30000);
});
