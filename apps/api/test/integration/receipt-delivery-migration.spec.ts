import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DatabaseService } from '../../src/database/database.service';
import { publishCommandObservation, signedEvidence, storeOriginalInbox, trustedEvidenceFixture } from '../support/trusted-evidence-fixtures';

const describeMigration = process.env.RUN_DB_TESTS === '1' && process.env.RUN_MIGRATION_TESTS === '1' ? describe : describe.skip;
describeMigration('R0.2 additive delivery migration', () => {
  const clients: DatabaseService[] = [], urls = new Map<DatabaseService, string>(), folder = resolve(__dirname, '../../drizzle');
  async function isolated() {
    const value = process.env.MIGRATION_ADMIN_URL;
    if (!value) throw new Error('Disposable local MIGRATION_ADMIN_URL required');
    const url = new URL(value);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local cluster required');
    const name = `fintech_r02_migration_${randomUUID().replaceAll('-', '')}`, admin = postgres(value, { max: 1 });
    try { await admin.unsafe(`create database "${name}"`); } finally { await admin.end(); }
    url.pathname = `/${name}`;
    const db = new DatabaseService(new ConfigService({ DATABASE_URL: url.toString() }));
    clients.push(db); urls.set(db, url.toString()); return db;
  }
  async function apply(db: DatabaseService, path = folder) {
    const sql = postgres(urls.get(db)!, { max: 1 });
    try { await migrate(drizzle(sql), { migrationsFolder: path }); } finally { await sql.end(); }
  }
  function staged(count: number, failing = false) {
    const path = resolve(__dirname, `../../../../.tmp/r02-migration-${randomUUID()}`);
    mkdirSync(resolve(path, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(resolve(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter(e => e.idx < count);
    writeFileSync(resolve(path, 'meta/_journal.json'), JSON.stringify(journal));
    for (const e of journal.entries) copyFileSync(resolve(folder, `${e.tag}.sql`), resolve(path, `${e.tag}.sql`));
    if (failing) {
      const file = resolve(path, '0008_conflicting_receipt_deliveries.sql');
      writeFileSync(file, readFileSync(file, 'utf8') + "\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'planned R02 rollback'; END $$;\n");
    }
    return path;
  }
  async function fingerprint(db: DatabaseService) {
    const result: Record<string, unknown> = {};
    for (const table of ['ledger_transactions', 'ledger_entries', 'capture_accounting_lots', 'refund_capture_allocations',
      'provider_financial_receipts', 'webhook_financial_evidence', 'provider_financial_observations', 'provider_financial_object_owners',
      'financial_evidence_reviews', 'receipt_admissions', 'receipt_admission_obligations', 'receipt_obligation_resolutions',
      'receipt_intake_authority', 'capture_accounting_scopes', 'webhook_events', 'accounting_exceptions']) {
      result[table] = await db.sql.unsafe(`select md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) as hash from public.${table} t`);
    }
    result.functions = await db.sql`select md5(string_agg(pg_get_functiondef(oid),'|' order by proname)) as hash from pg_proc
      where pronamespace='public'::regnamespace and proname in ('seal_financial_correlation','load_effective_financial_evidence','publish_admitted_receipt','check_receipt_admission_obligation','protect_ledger_entry_insert')`;
    return result;
  }
  async function history(db: DatabaseService) {
    const f = await trustedEvidenceFixture(db);
    await db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
    const financial = signedEvidence(f), id = await storeOriginalInbox(db, financial);
    await db.sql`select public.publish_admitted_receipt(${id},${f.account},${financial.raw},'isolated-SDK-fixture/v1')`;
    await db.sql`select public.seal_financial_correlation(${id},0)`;
    await db.sql`select public.bind_receipt_obligation(${id},1)`;
    const neutral = signedEvidence(f, { externalType: 'customer.created', object: { object: 'customer', id: `cus_${randomUUID()}` } });
    const neutralId = await storeOriginalInbox(db, neutral);
    await db.sql`select public.publish_admitted_receipt(${neutralId},${f.account},${neutral.raw},'isolated-SDK-fixture/v1')`;
    await db.sql`insert into financial_evidence_reviews(inbox_id,review_key,reason,observations) values(${id},${randomUUID()},'UNRESOLVED','{}')`;
    return { f, id, neutralId };
  }
  afterAll(async () => { for (const db of clients) await db.onApplicationShutdown(); });

  it('fresh ten-migration chain and repeated install create no delivery, barriers or activation', async () => {
    const db = await isolated(); await apply(db); const before = await fingerprint(db); await apply(db);
    expect(await fingerprint(db)).toEqual(before);
    expect((await db.sql`select (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
      (select count(*)::int from receipt_delivery_attempts) as attempts,(select count(*)::int from receipt_delivery_barriers) as barriers,
      (select count(*)::int from capture_accounting_scopes where status='ACTIVE') as active`)[0]).toEqual({ migrations: 10, attempts: 0, barriers: 0, active: 0 });
  }, 30000);
  it('populated 0007 upgrade preserves original financial and nonfinancial admission/proof/review evidence', async () => {
    const db = await isolated(); await apply(db, staged(8)); const h = await history(db), before = await fingerprint(db);
    await apply(db); expect(await fingerprint(db)).toEqual(before);
    expect(await db.sql`select id from receipt_delivery_attempts`).toHaveLength(0);
    expect((await db.sql`select financially_relevant from receipt_admissions where inbox_id=${h.neutralId}`)[0].financially_relevant).toBe(false);
    expect(await db.sql`select * from receipt_admission_obligations where inbox_id=${h.neutralId}`).toHaveLength(0);
    expect(await db.sql`select * from webhook_financial_evidence where inbox_id=${h.id}`).toHaveLength(1);
  }, 30000);
  it('existing R0 publisher, pending reader and original immutability remain compatible', async () => {
    const db = await isolated(); await apply(db); const f = await trustedEvidenceFixture(db), signed = signedEvidence(f, { status: 'pending' });
    const id = await storeOriginalInbox(db, signed);
    await db.sql`select public.publish_admitted_receipt(${id},${f.account},${signed.raw},'isolated-SDK-fixture/v1')`;
    expect(await db.sql`select * from public.inspect_receipt_admission('STRIPE',${f.account},${f.merchantId},'USD')`).toHaveLength(1);
    expect(await db.sql`select id from receipt_delivery_attempts`).toHaveLength(0);
    await expect(db.sql`update provider_financial_receipts set raw_body=raw_body where inbox_id=${id}`).rejects.toThrow(/immutable/);
    await expect(db.sql`update capture_accounting_scopes set status='ACTIVE' where merchant_id=${f.merchantId}`).rejects.toThrow(/check/);
  }, 30000);
  it('late 0008 failure rolls back new tables, capabilities and reader replacement', async () => {
    const db = await isolated(); await apply(db, staged(8)); await history(db); const before = await fingerprint(db);
    const [reader] = await db.sql`select pg_get_functiondef(oid) as definition,proacl::text as acl from pg_proc where oid='public.inspect_receipt_admission(text,text,uuid,text,bigint,bigint)'::regprocedure`;
    await expect(apply(db, staged(9, true))).rejects.toThrow(); expect(await fingerprint(db)).toEqual(before);
    expect((await db.sql`select pg_get_functiondef(oid) as definition,proacl::text as acl from pg_proc where oid='public.inspect_receipt_admission(text,text,uuid,text,bigint,bigint)'::regprocedure`)[0]).toEqual(reader);
    expect((await db.sql`select to_regclass('public.receipt_delivery_attempts') as attempts,to_regclass('public.receipt_delivery_barriers') as barriers,
      to_regprocedure('public.publish_verified_receipt_delivery(uuid,text,bytea,text,jsonb,jsonb,text)') as publisher,
      (select count(*)::int from drizzle.__drizzle_migrations) as migrations`)[0]).toEqual({ attempts: null, barriers: null, publisher: null, migrations: 8 });
  }, 30000);
  it('migration waits for the documented existing admission-table DDL lock and preserves history', async () => {
    const db = await isolated(); await apply(db, staged(8)); await history(db); const before = await fingerprint(db);
    let release!: () => void, ready!: () => void, holder = 0;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { ready = r; });
    const held = db.transaction(async tx => { holder = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid; await tx`lock table receipt_admissions in access exclusive mode`; ready(); await gate; });
    const sql = postgres(urls.get(db)!, { max: 1 }); let pending: Promise<void> | undefined;
    try {
      await Promise.race([started, held]); const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      expect(backend.pid).not.toBe(holder); pending = migrate(drizzle(sql), { migrationsFolder: folder });
      let waited = false;
      for (let i = 0; i < 150; i++) { if ((await db.sql<{ yes: boolean }[]>`select ${holder}=any(pg_blocking_pids(${backend.pid})) as yes`)[0].yes) { waited = true; break; } await delay(20); }
      expect(waited).toBe(true); release(); await held; await pending; expect(await fingerprint(db)).toEqual(before);
    } finally { release(); await Promise.allSettled([held, ...(pending ? [pending] : [])]); await sql.end(); }
  }, 30000);
  it('reused non-login owner and all new functions stay restricted without ledger writes or open financial gates', async () => {
    const db = await isolated(); await apply(db);
    const [role] = await db.sql`select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
      has_schema_privilege(oid,'public','CREATE') as schema_create,has_table_privilege(oid,'public.ledger_transactions','INSERT,UPDATE,DELETE,TRUNCATE') as ledger_write,
      has_table_privilege(oid,'public.receipt_delivery_barriers','UPDATE,DELETE,TRUNCATE') as barrier_mutation
      from pg_roles where rolname='fintech_admission_'||md5(current_database())`;
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, schema_create: false, ledger_write: false, barrier_mutation: false });
    const functions = await db.sql`select proname,proconfig,exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) where grantee=0 and privilege_type='EXECUTE') as public_execute
      from pg_proc where pronamespace='public'::regnamespace and proname in ('receipt_delivery_facts','check_receipt_delivery_barriers','publish_verified_receipt_delivery','inspect_receipt_admission')`;
    expect(functions).toHaveLength(4);
    for (const f of functions) { expect(f.proconfig).toEqual(['search_path=pg_catalog, pg_temp']); expect(f.public_execute).toBe(false); }
    expect((await db.sql`select count(*)::int as n from capture_accounting_scopes where status='ACTIVE'`)[0].n).toBe(0);
    expect((await db.sql`select count(*)::int as n from financial_evidence_accounts where runtime_enforcement<>'UNINSTALLED'`)[0].n).toBe(0);
  }, 30000);
});
