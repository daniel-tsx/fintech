import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DatabaseService } from '../../src/database/database.service';
import { publishCommandObservation, trustedEvidenceFixture } from '../support/trusted-evidence-fixtures';

const describeDb = process.env.RUN_DB_TESTS === '1' && process.env.RUN_MIGRATION_TESTS === '1' ? describe : describe.skip;
describeDb('D02-A fresh install and conservative 0008 upgrade', () => {
  const databases: DatabaseService[] = [], folder = resolve(__dirname, '../../drizzle');
  async function isolated() {
    const url = new URL(process.env.MIGRATION_ADMIN_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Disposable local cluster required');
    const admin = postgres(url.toString(), { max: 1 }), name = `fintech_d02_migration_${randomUUID().replaceAll('-', '')}`;
    try { await admin.unsafe(`create database "${name}"`); } finally { await admin.end(); }
    url.pathname = '/' + name;
    const db = new DatabaseService(new ConfigService({ DATABASE_URL: url.toString() })); databases.push(db);
    return { db, apply: async (source = folder) => { const sql = postgres(url.toString(), { max: 1 }); try { await migrate(drizzle(sql), { migrationsFolder: source }); } finally { await sql.end(); } } };
  }
  afterAll(async () => { for (const db of databases) await db.onApplicationShutdown(); });
  it('installs eleven migrations, narrow NOLOGIN owners and pinned definers with no PUBLIC publication capability', async () => {
    const { db, apply } = await isolated(); await apply(); await apply();
    expect((await db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(11);
    const owners = await db.sql<{ rolname: string }[]>`select rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls from pg_roles where rolname='fintech_observation_'||md5(current_database())`;
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    const functions = await db.sql`select p.proname,p.proconfig,r.rolname,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') public_execute
      from pg_proc p join pg_roles r on r.oid=p.proowner where p.pronamespace='public'::regnamespace and p.prosecdef and p.proname in
      ('guard_provider_command_identity','accept_provider_command','prepare_provider_execution','admit_provider_observation','publish_provider_observation','check_provider_source_complete')`;
    expect(functions).toHaveLength(6);
    for (const f of functions) { expect(f.proconfig).toEqual(['search_path=pg_catalog, pg_temp']); expect(f.public_execute).toBe(false); expect(f.rolname).toMatch(/^fintech_(observation|admission)_/); }
    const [ledger] = await db.sql`select has_table_privilege(${owners[0].rolname},'ledger_transactions','INSERT,UPDATE,DELETE,TRUNCATE') writes,
      has_any_column_privilege(${owners[0].rolname},'ledger_transactions','INSERT,UPDATE') columns`;
    expect(ledger).toEqual({ writes: false, columns: false });
    expect(await db.sql`select 1 from capture_accounting_scopes where status='ACTIVE'`).toHaveLength(0);
  }, 30000);
  it('upgrades existing evidence without blessing historical commands, reinterpreting proofs or rewriting money', async () => {
    const { db, apply } = await isolated(), target = resolve(__dirname, `../../../../.tmp/d02-before9-${randomUUID()}`);
    mkdirSync(resolve(target, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(resolve(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter(e => e.idx < 9);
    writeFileSync(resolve(target, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(resolve(folder, entry.tag + '.sql'), resolve(target, entry.tag + '.sql'));
    await apply(target); const f = await trustedEvidenceFixture(db); await db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
    const fingerprint = async () => (await db.sql`select
      (select md5(string_agg(to_jsonb(t)::text,'|' order by id)) from ledger_transactions t) journals,
      (select md5(string_agg(to_jsonb(t)::text,'|' order by id)) from ledger_entries t) entries,
      (select md5(string_agg(snapshot::text,'|' order by id)) from provider_financial_observations) snapshots,
      (select count(*)::int from provider_financial_observations) observations`)[0];
    const before = await fingerprint(); await apply(); await apply(); expect(await fingerprint()).toEqual(before);
    const [inventory] = await db.sql`select (select count(*)::int from provider_command_authorities) authorities,
      (select count(*)::int from provider_observation_sources) sources,(select count(*)::int from provider_observation_obligations) obligations,
      (select provider_mode from financial_evidence_accounts where provider_account=${f.account}) mode`;
    expect(inventory).toEqual({ authorities: 0, sources: 0, obligations: 0, mode: null });
    await expect(db.sql`select public.accept_provider_command(${f.captureCommandId},${f.account},'TEST')`).rejects.toThrow('account/mode');
  }, 30000);
});
