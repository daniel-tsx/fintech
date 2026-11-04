import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { firstCaptureIntentHarness } from '../support/first-capture-intent-harness';

const describeMigration = process.env.RUN_DB_TESTS === '1' && process.env.RUN_MIGRATION_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30000);
describeMigration('B2-B atomic forward migration and dormant privileges', () => {
  const folder = resolve(__dirname, '../../drizzle'), temporary = resolve(__dirname, '../../../../.tmp/r2-b2-b-tests');
  const harnesses: Awaited<ReturnType<typeof firstCaptureIntentHarness>>[] = [], stagedFolders: string[] = [];
  function staged(count: number, failure = false) {
    const target = resolve(temporary, randomUUID()); mkdirSync(resolve(target, 'meta'), { recursive: true }); stagedFolders.push(target);
    const journal = JSON.parse(readFileSync(resolve(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter(entry => entry.idx < count); writeFileSync(resolve(target, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(resolve(folder, entry.tag + '.sql'), resolve(target, entry.tag + '.sql'));
    if (failure) {
      const path = resolve(target, journal.entries.at(-1)!.tag + '.sql');
      writeFileSync(path, readFileSync(path, 'utf8') + "\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'planned B2-B migration rollback'; END $$;\n");
    }
    return target;
  }
  async function setup(source = folder) {
    const h = await firstCaptureIntentHarness(source); harnesses.push(h); const url = new URL(process.env.MIGRATION_ADMIN_URL!);
    url.pathname = '/' + String((await h.db.sql`select current_database() n`)[0].n);
    async function apply(from = folder) {
      const sql = postgres(url.toString(), { max: 1, connection: { statement_timeout: 15000 } });
      try { await migrate(drizzle(sql), { migrationsFolder: from }); } finally { await sql.end(); }
    }
    return { h, url, apply };
  }
  afterAll(async () => {
    for (const h of harnesses) await h.close(17);
    for (const path of stagedFolders) {
      if (!resolve(path).startsWith(temporary + sep)) throw new Error('Staged migration cleanup escaped task directory');
      rmSync(path, { recursive: true, force: true });
    }
  });
  async function data(sql: Sql, names?: string[]) {
    const selected = names ?? (await sql<{ name: string }[]>`select tablename name from pg_tables where schemaname='public' order by tablename`).map(row => row.name);
    const result: Record<string, unknown> = {};
    for (const name of selected) result[name] = await sql`select to_jsonb(t) row from ${sql('public.' + name)} t order by to_jsonb(t)::text`;
    return result;
  }
  async function catalog(sql: Sql) {
    return {
      functions: await sql<{ oid: number; proname: string; proowner: number; proacl: string | null; definition: string }[]>`select oid,proname,proowner,proacl::text,pg_get_functiondef(oid) definition
        from pg_proc where pronamespace='public'::regnamespace order by oid`,
      grants: await sql<{ oid: number; grantor: number; grantee: number; privilege_type: string; is_grantable: boolean; role_name: string | null }[]>`select p.oid,a.grantor,a.grantee,a.privilege_type,a.is_grantable,r.rolname role_name
        from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a left join pg_roles r on r.oid=a.grantee
        where p.pronamespace='public'::regnamespace order by p.oid,a.grantee,a.grantor,a.privilege_type`,
      constraints: await sql`select c.relname,k.conname,pg_get_constraintdef(k.oid) definition from pg_constraint k join pg_class c on c.oid=k.conrelid
        where c.relnamespace='public'::regnamespace order by c.relname,k.conname`,
      triggers: await sql`select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid
        where c.relnamespace='public'::regnamespace and not t.tgisinternal order by c.relname,t.tgname`,
      relations: await sql`select relname,relowner,relacl::text from pg_class where relnamespace='public'::regnamespace order by relname`,
      roles: await sql`select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles
        where position(md5(current_database()) in rolname)>0 order by rolname`,
      schema: await sql`select nspacl::text from pg_namespace where nspname='public'`,
    };
  }
  async function populated(timezone = 'UTC') {
    const result = await setup(staged(16)); await result.h.install();
    await result.h.worker.sql`select set_config('TimeZone',${timezone},false)`;
    const f = await result.h.fixture(), [accepted] = await result.h.accept(await result.h.request(f));
    const evidence = await result.h.captureEvidence(f, accepted.result); return { ...result, f, accepted: accepted.result, evidence };
  }
  it('installs all seventeen migrations repeatedly without enrolling a scope or granting operational execution', async () => {
    const { h, apply } = await setup(); await apply(); await apply();
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(17);
    for (const table of ['capture_preparation_issuances', 'financial_application_contracts', 'financial_application_scope_authority', 'financial_application_permits']) {
      expect(await h.db.sql`select 1 from ${h.db.sql(table)}`).toHaveLength(0);
    }
    expect(await h.db.sql`select 1 from capture_accounting_scopes where status='ACTIVE'`).toHaveLength(0);
    const functions = await h.db.sql`select p.proname,p.proconfig,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a join pg_roles r on r.oid=a.grantee where r.rolcanlogin and a.privilege_type='EXECUTE') login_execute
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in
        ('prepare_capture_application','read_capture_preparation','apply_capture_application','validate_capture_preparation','claim_capture_preparation','check_capture_application','financial_image_at_utc','financial_effects_at_utc')`;
    expect(functions).toHaveLength(8);
    for (const fn of functions) expect(fn).toMatchObject({ proconfig: expect.arrayContaining(['search_path=pg_catalog, pg_temp']) as unknown[], public_execute: false, login_execute: false });
    const owners = await h.db.sql<{ rolname: string }[]>`select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles
      where rolname in ('fintech_capture_prepare_'||md5(current_database()),'fintech_capture_check_'||md5(current_database()))`;
    expect(owners).toHaveLength(2);
    for (const owner of owners) {
      expect(owner).toMatchObject({ rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect(await h.db.sql`select 1 from pg_auth_members where roleid=(select oid from pg_roles where rolname=${owner.rolname})`).toHaveLength(0);
      const [rights] = await h.db.sql`select has_schema_privilege(${owner.rolname},'public','CREATE') schema_create,
        has_table_privilege(${owner.rolname},'public.financial_application_contracts','INSERT,UPDATE,DELETE') contract,
        has_table_privilege(${owner.rolname},'public.financial_application_scope_authority','INSERT,UPDATE,DELETE') enrollment`;
      expect(Object.values(rights)).toEqual([false, false, false]);
    }
  });
  it('preserves every populated0015 row, historical noncapture routine, OID, owner and existing grant', async () => {
    const { h, f, evidence, apply } = await populated(), before = await data(h.db.sql), old = await catalog(h.db.sql);
    await apply(); await apply(); expect(await data(h.db.sql, Object.keys(before))).toEqual(before);
    const current = await catalog(h.db.sql);
    const coordinated = new Set(['prepare_capture_application', 'guard_capture_preparation_issuance', 'check_capture_preparation_record', 'read_capture_preparation',
      'validate_capture_preparation', 'reject_capture_preparation_commit', 'guard_capture_preparation_write', 'capture_preparation_sources',
      'current_financial_application_manifest', 'validate_financial_application', 'guard_financial_application_records', 'complete_financial_application',
      'advance_financial_application_revision', 'guard_manual_authorization_authority', 'manual_authorization_blocked', 'check_financial_application_effect_finality',
      'inspect_receipt_admission', 'effective_receipt_admission_blockers', 'check_manual_authorization', 'check_first_capture_intent']);
    for (const fn of old.functions) {
      expect(current.functions).toEqual(expect.arrayContaining([expect.objectContaining({ oid: fn.oid, proname: fn.proname, proowner: fn.proowner,
        ...(!coordinated.has(fn.proname) ? { definition: fn.definition } : {}) })]));
    }
    expect(current.grants).toEqual(expect.arrayContaining([...old.grants]));
    const additions = current.grants.filter(grant => old.functions.some(fn => fn.oid === grant.oid) && !old.grants.some(previous => JSON.stringify(previous) === JSON.stringify(grant)));
    for (const grant of additions) {
      expect(grant.privilege_type).toBe('EXECUTE'); expect(grant.is_grantable).toBe(false);
      expect(grant.role_name).toMatch(/^fintech_(capture_(prepare|check|intent)|application|admission|manual_(authorization|claim|history|prepare))_[a-f0-9]{32}$/);
    }
    expect(current.constraints).toEqual(expect.arrayContaining([...old.constraints]));
    expect((await h.db.sql`select public.manual_authorization_history(${f.rootId}) valid`)[0].valid).toBe(true);
    expect((await h.db.sql`select public.check_first_capture_intent((select id from first_capture_intent_manifests where payment_id=${f.paymentId}),true,true) valid`)[0].valid).toBe(true);
    expect(await h.evidence.read(evidence.inboxId, 'payment.capture_succeeded')).toMatchObject({ id: evidence.proofId, capture_principal: '10000' });
    expect((await h.db.sql`select disposition,reason from provider_observation_obligations where source_id=${evidence.sourceId}`)[0])
      .toEqual({ disposition: 'BLOCKING_REVIEW', reason: 'CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED' });
    await expect(h.inspect(f)).rejects.toThrow(/blocked/);
  });
  it('a late0016 failure restores all definitions, owners, grants, triggers and populated evidence before retry', async () => {
    const { h, apply } = await populated(), before = await data(h.db.sql), old = await catalog(h.db.sql); let error: unknown;
    try { await apply(staged(17, true)); } catch (caught) { error = caught; }
    expect((error as { cause: Error }).cause.message).toMatch('planned B2-B migration rollback');
    expect(await data(h.db.sql)).toEqual(before); expect(await catalog(h.db.sql)).toEqual(old);
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(16);
    expect(await h.db.sql`select 1 from pg_proc where pronamespace='public'::regnamespace and proname='apply_capture_application'`).toHaveLength(0);
    await apply(); expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(17);
  });
  it('applies populated0015 non-UTC history without rewriting its immutable images', async () => {
    const { h, f, accepted, evidence, apply } = await populated('America/New_York');
    const names = ['manual_authorization_issuances', 'first_capture_intent_manifests', 'first_capture_intent_acceptances'];
    const before = await data(h.db.sql, names);
    await apply(); expect(await data(h.db.sql, names)).toEqual(before);
    await h.db.sql`insert into financial_application_contracts(family,phase,policy,version,prepare_function,validate_function)
      values('CAPTURE','TERMINAL','LEGACY',1,'public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure,
        'public.validate_capture_preparation(uuid)'::regprocedure)`;
    await h.db.sql.unsafe(`grant execute on function public.claim_capture_preparation(uuid),public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint),public.apply_capture_application() to "${h.worker.role}"`);
    const generation = Number((await h.worker.sql`select public.claim_capture_preparation(${evidence.inboxId}) n`)[0].n);
    const [r] = await h.db.sql`select c.id intent,c.merchant_id,c.currency,
      (select obligation_revision::text from receipt_admission_obligations where inbox_id=${evidence.inboxId}) obligation,
      (select evidence_revision::text from capture_accounting_scopes where merchant_id=c.merchant_id and currency=c.currency) scope,
      (select evidence_revision::text from receipt_intake_authority where provider=c.provider and provider_account=c.provider_account) intake
      from first_capture_intent_manifests c where attempt_id=${accepted.body.attemptId}`;
    await h.worker.sql.begin(async tx => {
      await tx`set local timezone='Asia/Bangkok'`;
      await tx`select public.prepare_capture_application(${String(r.intent)},${evidence.inboxId},${evidence.proofId},${generation},${String(r.obligation)},${String(r.scope)},${String(r.intake)})`;
      await tx`select public.apply_capture_application()`; await tx`set constraints all immediate`;
    });
    expect(await data(h.db.sql, names)).toEqual(before);
    expect((await h.db.sql`select public.manual_authorization_history(${f.rootId}) valid`)[0].valid).toBe(true);
    expect((await h.db.sql`select status,captured_amount::text from payments where id=${f.paymentId}`)[0]).toEqual({ status: 'CAPTURED', captured_amount: '10000' });
    expect((await h.db.sql`select status from webhook_events where id=${evidence.inboxId}`)[0].status).toBe('PROCESSED');
  });
  it('waits behind a real effect-table writer and exposes no partial executable capture package', async () => {
    const { h, url, apply } = await populated(); let release!: () => void, ready!: () => void, holder = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { ready = resolve; });
    const first = h.db.transaction(async tx => {
      holder = Number((await tx`select pg_backend_pid() p`)[0].p); await tx`lock table public.ledger_transactions in row exclusive mode`; ready(); await gate;
    });
    const sql = postgres(url.toString(), { max: 1, connection: { statement_timeout: 15000 } }); let pending: Promise<void> | undefined;
    try {
      await Promise.race([started, first]); const waiter = Number((await sql`select pg_backend_pid() p`)[0].p); expect(waiter).not.toBe(holder);
      pending = migrate(drizzle(sql), { migrationsFolder: folder }); let observed = false;
      for (let n = 0; n < 150; n++) {
        if ((await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) blocked`)[0].blocked) { observed = true; break; } await delay(20);
      }
      expect(observed).toBe(true);
      expect(await h.db.sql`select 1 from pg_proc where pronamespace='public'::regnamespace and proname='apply_capture_application'`).toHaveLength(0);
      expect(String((await h.db.sql`select pg_get_functiondef('public.validate_capture_preparation(uuid)'::regprocedure) definition`)[0].definition)).toMatch('cannot commit before B2-B');
      release(); await Promise.all([first, pending]); await apply();
      expect(await h.db.sql`select 1 from pg_proc where pronamespace='public'::regnamespace and proname='apply_capture_application'`).toHaveLength(1);
    } finally { release(); await Promise.allSettled([first, ...(pending ? [pending] : [])]); await sql.end(); }
  });
});
