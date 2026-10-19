import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { AuditService } from '../../src/audit/audit.service';
import { DatabaseService } from '../../src/database/database.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { CaptureRefundAccountingService } from '../../src/refunds/capture-refund-accounting.service';
import { captureFixture } from '../support/accounting-fixtures';

const describeMigration=process.env.RUN_DB_TESTS==='1'&&process.env.RUN_MIGRATION_TESTS==='1'?describe:describe.skip;
class DormantRefund extends CaptureRefundAccountingService {protected assertActiveScope(status:string){if(status!=='FOUNDATION_ONLY')throw new Error('Expected dormant scope');}}
describeMigration('B3.2 B.1 forward migration and closed financial floor',()=>{
  const clients:DatabaseService[]=[];const urls=new Map<DatabaseService,string>();const folder=resolve(__dirname,'../../drizzle');
  async function isolated(){const value=process.env.MIGRATION_ADMIN_URL;if(!value)throw new Error('MIGRATION_ADMIN_URL must name a disposable local cluster');
    const url=new URL(value);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Local cluster required');
    const admin=postgres(value,{max:1}),name=`fintech_b32b1_migration_${randomUUID().replaceAll('-','')}`;
    try{await admin.unsafe(`create database "${name}"`);}finally{await admin.end();}url.pathname=`/${name}`;
    const db=new DatabaseService(new ConfigService({DATABASE_URL:url.toString()}));clients.push(db);urls.set(db,url.toString());return db;}
  async function apply(db:DatabaseService,path=folder){const client=postgres(urls.get(db)!,{max:1});try{await migrate(drizzle(client),{migrationsFolder:path});}finally{await client.end();}}
  function stagedFolder(before:number,failing=false){const target=resolve(__dirname,`../../../../.tmp/b32b1-migrations-${randomUUID()}`);mkdirSync(resolve(target,'meta'),{recursive:true});
    const journal=JSON.parse(readFileSync(resolve(folder,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string}[]};journal.entries=journal.entries.filter(e=>e.idx<before);
    writeFileSync(resolve(target,'meta/_journal.json'),JSON.stringify(journal));for(const e of journal.entries)copyFileSync(resolve(folder,`${e.tag}.sql`),resolve(target,`${e.tag}.sql`));
    if(failing){const path=resolve(target,'0006_trusted_financial_evidence.sql');writeFileSync(path,readFileSync(path,'utf8')+"\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'planned migration rollback'; END $$;\n");}return target;}
  afterAll(async()=>{for(const db of clients)await db.onApplicationShutdown();});
  async function originals(db:DatabaseService){return (await db.sql`select
    (select md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by t.id),'')) from ledger_transactions t) as journals,
    (select md5(coalesce(string_agg(to_jsonb(e)::text,'|' order by e.id),'')) from ledger_entries e) as entries,
    (select md5(coalesce(string_agg(to_jsonb(l)::text,'|' order by l.id),'')) from capture_accounting_lots l) as lots,
    (select md5(coalesce(string_agg((to_jsonb(a)-'evidence_contract_version'-'proof_revision')::text,'|' order by a.id),'')) from refund_capture_allocations a) as allocations,
    (select md5(coalesce(string_agg(to_jsonb(w)::text,'|' order by w.id),'')) from webhook_events w) as inbox,
    (select md5(coalesce(string_agg(pg_get_functiondef(p.oid),'|' order by p.proname),'')) from pg_proc p where p.pronamespace='public'::regnamespace
      and p.proname in ('prepare_capture_allocation_write','check_capture_allocation_effect','check_capture_allocation_bounds',
      'assert_ledger_transaction_balanced','protect_ledger_entry_insert','protect_immutable_financial_rows','reject_ledger_truncate','protect_webhook_evidence')) as functions`)[0];}
  async function legacy(db:DatabaseService){const f=await captureFixture(db);await db.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD')`;
    await db.sql`insert into capture_accounting_lots (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at)
      select ${f.attemptId},${f.paymentId},${f.merchantId},'USD',id,10000,300,9700,posted_at,posted_at from ledger_transactions where id=${f.journalId}`;
    const service=new DormantRefund(db,new IdempotencyService(db),new OutboxService(),new AuditService(),new LedgerService(db));
    const {value:refund}=await service.create({id:randomUUID(),type:'API_KEY',role:'MERCHANT_ADMIN',merchantId:f.merchantId},f.paymentId,randomUUID(),{amount:5000});
    const payload={id:`evt_${randomUUID()}`,type:'refund.succeeded',data:{merchantId:f.merchantId,paymentId:f.paymentId,refundId:refund.id,amount:5000,currency:'USD',providerTransactionId:`re_${refund.id}`,paymentIntentId:`pi_${f.paymentId}`}};
    const [inbox]=await db.sql<{id:string}[]>`insert into webhook_events (provider,provider_event_id,event_type,signature,payload,status) values ('STRIPE',${payload.id},'refund.succeeded','historical-fixture',${db.sql.json(payload)},'PENDING') returning id`;
    await db.transaction(tx=>service.applySucceeded(tx,inbox.id));return {...f,refundId:refund.id,inboxId:inbox.id};}
  it('fresh ten-migration chain installs zero evidence/active scopes; repeated migration is a no-op',async()=>{
    const db=await isolated();await apply(db);const before=await originals(db);await apply(db);expect(await originals(db)).toEqual(before);
    const [r]=await db.sql`select (select count(*)::integer from drizzle.__drizzle_migrations) as migrations,
      (select count(*)::integer from provider_financial_receipts) as receipts,(select count(*)::integer from webhook_financial_evidence) as proofs,
      (select count(*)::integer from financial_evidence_accounts) as accounts,(select count(*)::integer from capture_accounting_scopes where status='ACTIVE') as active`;
    expect(r).toEqual({migrations:10,receipts:0,proofs:0,accounts:0,active:0});await expect(db.sql`select public.assert_financial_evidence_runtime_ready()`).rejects.toThrow(/UNINSTALLED/);
  },30000);
  it('populated 0005 upgrade preserves finalized financial history and unapplied historical receipt without manufacturing trust',async()=>{
    const db=await isolated();await apply(db,stagedFolder(6));const f=await legacy(db);
    const [pending]=await db.sql<{id:string}[]>`insert into webhook_events (provider,provider_event_id,event_type,signature,payload) values ('STRIPE',${`evt_${randomUUID()}`},'refund.succeeded','historical-unapplied',${db.sql.json({type:'refund.succeeded',data:{refundId:f.refundId,paymentId:f.paymentId,merchantId:f.merchantId,amount:5000,currency:'USD'}})}) returning id`;
    const before=await originals(db);await apply(db);expect(await originals(db)).toEqual(before);
    expect((await db.sql`select evidence_contract_version,proof_revision,status from refund_capture_allocations where refund_id=${f.refundId}`)[0]).toEqual({evidence_contract_version:0,proof_revision:null,status:'CONFIRMED'});
    expect((await db.sql`select status from webhook_events where id=${pending.id}`)[0].status).toBe('PENDING');
    expect(await db.sql`select inbox_id from provider_financial_receipts`).toHaveLength(0);expect(await db.sql`select inbox_id from webhook_financial_evidence`).toHaveLength(0);
    await expect(db.sql`select public.financial_receipt_facts(${f.inboxId})`).rejects.toThrow(/unavailable/);
    await expect(db.sql`update ledger_entries set debit=debit where transaction_id=${f.journalId}`).rejects.toThrow(/immutable/);
  },30000);
  it('legacy dormant writer remains valid after installation without claiming proof-contract application',async()=>{
    const db=await isolated();await apply(db);const f=await legacy(db);
    expect((await db.sql`select status,platform_fee_amount::text from refunds where id=${f.refundId}`)[0]).toEqual({status:'SUCCEEDED',platform_fee_amount:'150'});
    expect((await db.sql`select evidence_contract_version,proof_revision from refund_capture_allocations where refund_id=${f.refundId}`)[0]).toEqual({evidence_contract_version:0,proof_revision:null});
    expect(await db.sql`select inbox_id from webhook_financial_evidence`).toHaveLength(0);
  },30000);
  it('unverifiable orphan capture is retained but never promoted by 0006',async()=>{
    const db=await isolated();await apply(db,stagedFolder(6));const ledger=new LedgerService(db);
    const journal=await db.transaction(tx=>ledger.post(tx,{merchantId:null,businessType:'CAPTURE',businessId:randomUUID(),currency:'USD',description:'Unscopable legacy original preserved for review',lines:[
      {accountCode:'PSP_CLEARING',merchantId:null,debit:100},{accountCode:'PLATFORM_FEE_REVENUE',merchantId:null,credit:100}]}));
    const before=await originals(db);await apply(db);expect(await originals(db)).toEqual(before);expect(await db.sql`select id from ledger_transactions where id=${journal}`).toHaveLength(1);
    expect(await db.sql`select inbox_id from webhook_financial_evidence`).toHaveLength(0);expect(await db.sql`select id from capture_accounting_lots where capture_journal_id=${journal}`).toHaveLength(0);
  },30000);
  it('late migration error rolls back columns, functions, evidence tables and its new non-login owner',async()=>{
    const db=await isolated();await apply(db,stagedFolder(6));await legacy(db);const before=await originals(db);let error:unknown;
    try{await apply(db,stagedFolder(7,true));}catch(e:unknown){error=e;}expect(error).toBeDefined();expect((error as {cause:Error}).cause.message).toMatch(/planned migration rollback/);
    expect(await originals(db)).toEqual(before);const [r]=await db.sql`select to_regclass('public.webhook_financial_evidence') as proof,
      (select count(*)::integer from drizzle.__drizzle_migrations) as migrations,
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='refund_capture_allocations' and column_name='evidence_contract_version') as added_column,
      exists(select 1 from pg_roles where rolname='fintech_evidence_'||md5(current_database())) as owner`;
    expect(r).toEqual({proof:null,migrations:6,added_column:false,owner:false});
  },30000);
  it('maintenance DDL visibly waits for an existing writer then installs atomically',async()=>{
    const db=await isolated();await apply(db,stagedFolder(6));let release!:()=>void,ready!:()=>void;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});let blocker=0;
    const held=db.transaction(async tx=>{blocker=(await tx<{pid:number}[]>`select pg_backend_pid() as pid`)[0].pid;await tx`lock table public.refund_capture_allocations in row exclusive mode`;ready();await gate;});
    const migration=postgres(urls.get(db)!,{max:1});let installing:Promise<void>|undefined;
    try{await Promise.race([started,held]);const waiter=(await migration<{pid:number}[]>`select pg_backend_pid() as pid`)[0].pid;installing=migrate(drizzle(migration),{migrationsFolder:folder});
      let blocked=false;for(let i=0;i<150;i++){const [r]=await db.sql<{blocked:boolean}[]>`select ${blocker}=any(pg_blocking_pids(${waiter})) as blocked`;if(r.blocked){blocked=true;break;}await delay(20);}expect(blocked).toBe(true);
      expect((await db.sql`select to_regclass('public.webhook_financial_evidence') as proof`)[0].proof).toBeNull();release();await Promise.all([held,installing]);
      expect((await db.sql`select count(*)::integer as count from drizzle.__drizzle_migrations`)[0].count).toBe(10);
    }finally{release();await Promise.allSettled([held,...(installing?[installing]:[])]);await migration.end();}
  },30000);
});
