import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DatabaseService } from '../../src/database/database.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { AuditService } from '../../src/audit/audit.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { SettlementsService } from '../../src/settlements/settlements.service';
import { captureFixture } from '../support/accounting-fixtures';

// These create and RETAIN disposable databases. Never accept a remote admin URL.
const describeMigration = process.env.RUN_DB_TESTS === '1' && process.env.RUN_MIGRATION_TESTS === '1' ? describe : describe.skip;
describeMigration('B1 migration freshness and conservative legacy upgrade', () => {
  const databases: DatabaseService[] = [];
  const urls = new Map<DatabaseService,string>();
  const folder = resolve(__dirname,'../../drizzle');
  async function isolated() {
    const value = process.env.MIGRATION_ADMIN_URL;
    if (!value) throw new Error('MIGRATION_ADMIN_URL must name a disposable local PostgreSQL cluster');
    const url = new URL(value);
    if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Migration fixtures require localhost');
    const admin = postgres(value,{max:1}); const name = `fintech_b1_migration_${randomUUID().replaceAll('-','')}`;
    try { await admin.unsafe(`create database "${name}"`); } finally { await admin.end(); }
    url.pathname=`/${name}`;
    const database = new DatabaseService(new ConfigService({DATABASE_URL:url.toString()})); databases.push(database); urls.set(database,url.toString());
    return database;
  }
  afterAll(async () => { for (const database of databases) await database.onApplicationShutdown(); });
  async function apply(database: DatabaseService, migrationsFolder: string) {
    // Drizzle configures JSON serializers on its client. Keep the application's
    // postgres.js client separate, as the normal migration entry point does.
    const client = postgres(urls.get(database)!,{max:1});
    try { await migrate(drizzle(client),{migrationsFolder}); } finally { await client.end(); }
  }
  async function fingerprint(database: DatabaseService) {
    const [row] = await database.sql`select
      (select md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by t.id),'')) from ledger_transactions t) as journals,
      (select md5(coalesce(string_agg(to_jsonb(e)::text,'|' order by e.id),'')) from ledger_entries e) as entries`;
    return row;
  }
  function historicalFolder(before = 4) {
    const target = resolve(__dirname,`../../../../.tmp/b1-migrations-${randomUUID()}`); mkdirSync(resolve(target,'meta'),{recursive:true});
    const journal = JSON.parse(readFileSync(resolve(folder,'meta/_journal.json'),'utf8')) as { entries: {idx:number;tag:string}[] };
    journal.entries=journal.entries.filter((entry) => entry.idx<before);
    writeFileSync(resolve(target,'meta/_journal.json'),JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(resolve(folder,`${entry.tag}.sql`),resolve(target,`${entry.tag}.sql`));
    return target;
  }
  it('installs 0000–0005 on an empty database; repeated migrator execution is a no-op', async () => {
    const database = await isolated(); await apply(database,folder);
    const before = await fingerprint(database); await apply(database,folder);
    expect(await fingerprint(database)).toEqual(before);
    const [row] = await database.sql`select (select count(*)::integer from drizzle.__drizzle_migrations) as migrations,
      (select count(*)::integer from capture_accounting_lots) as lots,(select count(*)::integer from accounting_exceptions) as exceptions`;
    expect(row).toMatchObject({migrations:6,lots:0,exceptions:0});
    const functions = await database.sql<{prosecdef:boolean;proconfig:string[]}[]>`select prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname in
      ('validate_capture_accounting_lot','prepare_capture_allocation_write','check_capture_allocation_bounds','require_accounting_journal','check_capture_allocation_effect','protect_accounting_foundation_evidence','check_accounting_settlement_evidence','protect_allocated_intent_amount')`;
    expect(functions).toHaveLength(8);
    for (const f of functions) { expect(f.prosecdef).toBe(false); expect(f.proconfig).toEqual(['search_path=pg_catalog, pg_temp']); }
  },30000);
  it('upgrades 0004 with a dormant exception disposition without rewriting history or activating scopes', async () => {
    const database = await isolated(); await apply(database,historicalFolder(5));
    const f = await captureFixture(database);
    await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD')`;
    const before = await fingerprint(database); await apply(database,folder); await apply(database,folder);
    expect(await fingerprint(database)).toEqual(before);
    const labels = await database.sql<{enumlabel:string}[]>`select enumlabel from pg_enum where enumtypid='public.inbox_status'::regtype and enumlabel='ACCOUNTING_EXCEPTION'`;
    expect(labels).toEqual([{enumlabel:'ACCOUNTING_EXCEPTION'}]);
    const [scope] = await database.sql`select status from capture_accounting_scopes where merchant_id=${f.merchantId}`;
    expect(scope.status).toBe('FOUNDATION_ONLY');
    // The label is usable only after the migrator's transaction has committed.
    await database.sql`insert into webhook_events (provider,provider_event_id,event_type,signature,payload,status)
      values ('STRIPE',${randomUUID()},'local.fixture','local-fixture','{}'::jsonb,'ACCOUNTING_EXCEPTION')`;
  },30000);
  it('preserves immutable history and inventories clean, settled, adjusted and invalid legacy captures', async () => {
    const database = await isolated(); await apply(database,historicalFolder());
    const ledger = new LedgerService(database); const audit = new AuditService();
    const service = new SettlementsService(database,ledger,audit); const disputes = new DisputesService(ledger,audit);
    const cases: {f:Awaited<ReturnType<typeof captureFixture>>;classification:string}[] = [];
    const clean = await captureFixture(database); cases.push({f:clean,classification:'ORIGINAL_VERIFIED'});
    const pending = await captureFixture(database); await service.generate(pending.merchantId); cases.push({f:pending,classification:'REVIEW_REQUIRED'});
    const settled = await captureFixture(database); const [id] = await service.generate(settled.merchantId);
    await database.transaction((tx) => service.complete(tx,id)); cases.push({f:settled,classification:'REVIEW_REQUIRED'});
    for (const gross of [5000,10000]) {
      const f = await captureFixture(database);
      await database.transaction(async (tx) => {
        const [r] = await tx<{id:string}[]>`insert into refunds (merchant_id,payment_id,status,amount,platform_fee_amount,currency) values (${f.merchantId},${f.paymentId},'SUCCEEDED',${gross},${gross*3/100},'USD') returning id`;
        await ledger.post(tx,{merchantId:f.merchantId,businessType:'REFUND',businessId:r.id,currency:'USD',description:'Legacy refund fixture',lines:[
          {accountCode:'MERCHANT_PENDING',merchantId:f.merchantId,debit:gross-gross*3/100},
          {accountCode:'PLATFORM_FEE_REFUNDS',merchantId:null,debit:gross*3/100},{accountCode:'PSP_CLEARING',merchantId:null,credit:gross},
        ]});
        await tx`update payments set refunded_amount=${gross},status=${gross===10000?'REFUNDED':'PARTIALLY_REFUNDED'} where id=${f.paymentId}`;
      });
      cases.push({f,classification:'REVIEW_REQUIRED'});
    }
    const disputed = await captureFixture(database);
    await database.transaction((tx) => disputes.open(tx,{merchantId:disputed.merchantId,paymentId:disputed.paymentId,providerDisputeId:randomUUID(),amount:5000,currency:'USD'}));
    cases.push({f:disputed,classification:'REVIEW_REQUIRED'});
    // A balanced but noncanonical CAPTURE is valid under the old schema; it is
    // insufficient ownership evidence and must never become a guessed lot.
    const invalid = await captureFixture(database);
    const invalidAttempt = randomUUID();
    await database.sql`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency) values (${invalidAttempt},${invalid.merchantId},${invalid.paymentId},'CAPTURE','SUCCEEDED',100,'USD')`;
    await database.transaction((tx) => ledger.post(tx,{merchantId:invalid.merchantId,businessType:'CAPTURE',businessId:invalidAttempt,currency:'USD',description:'Invalid legacy attribution fixture',lines:[
      {accountCode:'PLATFORM_CASH',merchantId:null,debit:100},{accountCode:'MERCHANT_AVAILABLE',merchantId:invalid.merchantId,credit:100},
    ]}));
    cases.push({f:{...invalid,attemptId:invalidAttempt},classification:'REVIEW_REQUIRED'});
    const missing = randomUUID();
    await database.sql`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency) values (${missing},${invalid.merchantId},${invalid.paymentId},'CAPTURE','SUCCEEDED',100,'USD')`;
    cases.push({f:{...invalid,attemptId:missing},classification:'REVIEW_REQUIRED'});
    const orphan = await database.transaction((tx) => ledger.post(tx,{merchantId:invalid.merchantId,businessType:'CAPTURE',businessId:randomUUID(),currency:'USD',description:'Orphan capture evidence fixture',lines:[
      {accountCode:'PSP_CLEARING',merchantId:null,debit:100},{accountCode:'MERCHANT_PENDING',merchantId:invalid.merchantId,credit:100},
    ]}));
    const before = await fingerprint(database);
    const functionsBefore = await database.sql<{proname:string;definition:string}[]>`select proname,pg_get_functiondef(oid) as definition from pg_proc where pronamespace='public'::regnamespace order by proname`;
    await apply(database,folder); expect(await fingerprint(database)).toEqual(before);
    const [orphanException] = await database.sql`select status,observed_conflict->>'journal_id' as journal from accounting_exceptions where evidence_key=${`legacy-journal:${orphan}`}`;
    expect(orphanException).toMatchObject({status:'OPEN',journal:orphan});
    for (const c of cases) {
      const [inventory] = await database.sql`select classification from capture_accounting_legacy_inventory where capture_attempt_id=${c.f.attemptId}`;
      expect(inventory.classification).toBe(c.classification);
      const lots = await database.sql`select eligible_at,origin from capture_accounting_lots where capture_attempt_id=${c.f.attemptId}`;
      if (c.classification==='ORIGINAL_VERIFIED') expect(lots).toMatchObject([{eligible_at:null,origin:'LEGACY_ORIGINAL_ONLY'}]);
      else {
        expect(lots).toHaveLength(0);
        const [exception] = await database.sql`select status,observed_conflict->>'capture_attempt_id' as attempt from accounting_exceptions where evidence_key=${`legacy-capture:${c.f.attemptId}`}`;
        expect(exception).toMatchObject({status:'OPEN',attempt:c.f.attemptId});
      }
    }
    for (const row of functionsBefore) {
      const [now] = await database.sql`select pg_get_functiondef(oid) as definition from pg_proc where pronamespace='public'::regnamespace and proname=${row.proname}`;
      expect(now.definition).toBe(row.definition); // Includes all F02 function context/sealing.
    }
    await expect(database.sql`update capture_accounting_scopes set status='ACTIVE' where merchant_id=${clean.merchantId}`).rejects.toThrow(/check constraint/i);
    const [allocations] = await database.sql`select (select count(*)::integer from refund_capture_allocations) as refunds,(select count(*)::integer from dispute_capture_allocations) as disputes`;
    expect(allocations).toMatchObject({refunds:0,disputes:0});
    const [countsBefore] = await database.sql`select count(*)::integer as exceptions from accounting_exceptions`;
    await apply(database,folder); expect(await fingerprint(database)).toEqual(before);
    const [countsAfter] = await database.sql`select count(*)::integer as exceptions from accounting_exceptions`; expect(countsAfter).toEqual(countsBefore);
  },30000);
  it('classifies NULL-owned legacy pending entries for review while backfilling a valid capture', async () => {
    const database = await isolated(); await apply(database,historicalFolder());
    const valid = await captureFixture(database);
    const merchantId = randomUUID(), paymentId = randomUUID(), attemptId = randomUUID();
    const ledger = new LedgerService(database);
    const journal = await database.transaction(async (tx) => {
      await tx`insert into merchants (id,name,settlement_delay_days) values (${merchantId},'NULL ownership upgrade fixture',0)`;
      await tx`insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,captured_amount,platform_fee_amount,payment_method_token)
        values (${paymentId},${merchantId},'CAPTURED','MANUAL','USD',10000,10000,10000,300,'pm_test')`;
      await tx`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency) values (${attemptId},${merchantId},${paymentId},'CAPTURE','SUCCEEDED',10000,'USD')`;
      return ledger.post(tx,{merchantId,businessType:'CAPTURE',businessId:attemptId,currency:'USD',description:'Unverifiable legacy pending ownership',lines:[
        {accountCode:'PSP_CLEARING',merchantId:null,debit:10000},
        {accountCode:'MERCHANT_PENDING',merchantId:null,credit:9700},
        {accountCode:'PLATFORM_FEE_REVENUE',merchantId:null,credit:300},
      ]});
    });
    const before = await fingerprint(database); await apply(database,folder);
    expect(await fingerprint(database)).toEqual(before);
    const [invalid] = await database.sql`select original_valid,classification from capture_accounting_legacy_inventory where capture_attempt_id=${attemptId}`;
    expect(invalid).toEqual({original_valid:false,classification:'REVIEW_REQUIRED'});
    expect(await database.sql`select id from capture_accounting_lots where capture_attempt_id=${attemptId}`).toHaveLength(0);
    const [exception] = await database.sql`select status,payment_id,observed_conflict->>'journal_id' as journal from accounting_exceptions where evidence_key=${`legacy-capture:${attemptId}`}`;
    expect(exception).toMatchObject({status:'OPEN',payment_id:paymentId,journal});
    const [scope] = await database.sql`select status from capture_accounting_scopes where merchant_id=${merchantId}`;
    expect(scope.status).toBe('REVIEW_REQUIRED');
    const [clean] = await database.sql`select origin,eligible_at from capture_accounting_lots where capture_attempt_id=${valid.attemptId}`;
    expect(clean).toEqual({origin:'LEGACY_ORIGINAL_ONLY',eligible_at:null});
    await expect(database.sql`insert into capture_accounting_lots (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at)
      select ${attemptId},${paymentId},${merchantId},'USD',id,10000,300,9700,posted_at,posted_at from ledger_transactions where id=${journal}`).rejects.toThrow(/agree with one immutable POSTED CAPTURE/i);
  },30000);
  it('refuses unscoped CAPTURE evidence atomically without rewriting or losing history', async () => {
    const database = await isolated(); await apply(database,historicalFolder());
    const ledger = new LedgerService(database);
    await database.transaction((tx) => ledger.post(tx,{merchantId:null,businessType:'CAPTURE',businessId:randomUUID(),currency:'USD',description:'Unscoped legacy evidence fixture',lines:[
      {accountCode:'PSP_CLEARING',merchantId:null,debit:100},{accountCode:'PLATFORM_FEE_REVENUE',merchantId:null,credit:100},
    ]}));
    const before = await fingerprint(database);
    // Drizzle wraps the original PostgreSQL exception; assert its cause too.
    let rejection: unknown;
    try { await apply(database,folder); } catch (error: unknown) { rejection=error; }
    expect(rejection).toBeDefined();
    expect((rejection as {cause:Error}).cause.message).toMatch(/Unscoped legacy CAPTURE/i);
    expect(await fingerprint(database)).toEqual(before);
    const [row] = await database.sql`select to_regclass('public.capture_accounting_lots') as lots,(select count(*)::integer from drizzle.__drizzle_migrations) as migrations`;
    expect(row).toMatchObject({lots:null,migrations:4});
  },30000);
});
