import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { providerObservationHarness } from '../support/provider-observation-harness';
import { publishCommandObservation, signedEvidence } from '../support/trusted-evidence-fixtures';

const describeDb=process.env.RUN_DB_TESTS==='1'&&process.env.RUN_MIGRATION_TESTS==='1'?describe:describe.skip;
describeDb('R2-B1 forward migration and legacy compatibility',()=>{
  const folder=resolve(__dirname,'../../drizzle'),all:Awaited<ReturnType<typeof providerObservationHarness>>[]=[];
  function staged(failure=false){
    const target=resolve(__dirname,`../../../../.tmp/r2b1-migration-${randomUUID()}`);mkdirSync(resolve(target,'meta'),{recursive:true});
    const journal=JSON.parse(readFileSync(resolve(folder,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string}[]};
    journal.entries=journal.entries.filter(e=>e.idx<(failure?12:11));writeFileSync(resolve(target,'meta/_journal.json'),JSON.stringify(journal));
    for(const e of journal.entries)copyFileSync(resolve(folder,e.tag+'.sql'),resolve(target,e.tag+'.sql'));
    if(failure){const p=resolve(target,'0011_payment_operation_evidence.sql');writeFileSync(p,readFileSync(p,'utf8')+"\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'planned B1 rollback'; END $$;\n");}
    return target;
  }
  async function setup(source=folder){const h=await providerObservationHarness(source);all.push(h);
    const url=new URL(process.env.MIGRATION_ADMIN_URL!);url.pathname='/'+String((await h.db.sql`select current_database() n`)[0].n);
    const apply=async(from=folder)=>{const sql=postgres(url.toString(),{max:1});try{await migrate(drizzle(sql),{migrationsFolder:from});}finally{await sql.end();}};
    return{h,url,apply};}
  afterAll(async()=>{for(const h of all)await h.close();});
  async function fingerprint(sql:Sql){const out:Record<string,unknown>={};
    for(const table of ['ledger_transactions','ledger_entries','capture_accounting_lots','refund_capture_allocations','provider_financial_receipts','webhook_financial_evidence',
      'receipt_admissions','receipt_admission_obligations','provider_command_authorities','provider_command_executions','provider_observation_sources','provider_observation_obligations']){
      out[table]=(await sql.unsafe(`select md5(coalesce(string_agg(j,'|' order by j),'')) hash from (select (to_jsonb(t)-'payment_operation_proof_id')::text j from public.${table} t) s`))[0].hash;
    }return out;}
  it('fresh twelve-migration installation is repeatable, restricted and financially closed',async()=>{
    const{h,apply}=await setup();await apply();expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(12);
    for(const table of ['payment_operation_evidence','financial_application_contracts','financial_application_scope_authority','financial_application_permits','financial_applications'])expect(await h.db.sql.unsafe(`select 1 from public.${table}`)).toHaveLength(0);
    const[owner]=await h.db.sql`select rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls from pg_roles where rolname='fintech_payment_evidence_'||md5(current_database())`;
    expect(owner).toEqual({rolcanlogin:false,rolinherit:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false});
    const rights=await h.db.sql`select p.proname,p.proconfig,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') public_execute
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('load_effective_payment_operation_evidence','seal_payment_operation_evidence','publish_admitted_payment_receipt','bind_payment_operation_obligation')`;
    expect(rights).toHaveLength(4);for(const r of rights){expect(r.public_execute).toBe(false);expect(r.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);}
    expect(await h.db.sql`select 1 from capture_accounting_scopes where status='ACTIVE'`).toHaveLength(0);
  },30000);
  it('populated0010 upgrade preserves money, D02 bytes, contract1 classification and bound refund proof',async()=>{
    const{h,apply}=await setup(staged()),f=await h.accepted();await h.db.transaction(tx=>publishCommandObservation(tx,f,'CAPTURE'));await(await f.producer.execute(f.message)).publish();
    await h.db.sql`insert into refund_capture_allocations(refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross) values(${f.operationId},${f.lotId},${f.paymentId},${f.merchantId},'USD',2000)`;
    const signed=signedEvidence({...f,refundId:f.operationId,objectId:f.object.id},{object:{amount:2000}}),attested=h.sign(signed.raw);
    const receipt=await h.receiver(f.account).receive(attested.raw,attested.signature);expect(await h.correlate(f.account).correlate(receipt.id)).toMatchObject({state:'BOUND'});
    const before=await fingerprint(h.db.sql),facts:unknown=(await h.db.sql`select public.receipt_admission_facts(${receipt.id}) f`)[0].f;
    await apply();await apply();expect(await fingerprint(h.db.sql)).toEqual(before);expect((await h.db.sql`select public.receipt_admission_facts(${receipt.id}) f`)[0].f).toEqual(facts);
    expect(await h.correlate(f.account).correlate(receipt.id)).toMatchObject({state:'BOUND'});
    await expect(h.db.sql`update ledger_entries set debit=debit where transaction_id=${f.journalId}`).rejects.toThrow(/immutable/);
    expect(await h.db.sql`select 1 from payment_operation_evidence`).toHaveLength(0);
  },30000);
  it('late0011 rejection rolls back tables, functions, privileges and constraint changes',async()=>{
    const{h,apply}=await setup(staged()),f=await h.accepted();await(await f.producer.execute(f.message)).publish();const before=await fingerprint(h.db.sql);
    const prior=String((await h.db.sql`select pg_get_functiondef('public.receipt_admission_facts(uuid)'::regprocedure) body`)[0].body);
    let error:unknown;try{await apply(staged(true));}catch(e){error=e;}expect((error as {cause:Error}).cause.message).toMatch(/planned B1 rollback/);
    expect(await fingerprint(h.db.sql)).toEqual(before);expect((await h.db.sql`select pg_get_functiondef('public.receipt_admission_facts(uuid)'::regprocedure) body`)[0].body).toBe(prior);
    expect((await h.db.sql`select to_regclass('public.payment_operation_evidence') relation,exists(select 1 from pg_roles where rolname='fintech_payment_evidence_'||md5(current_database())) owner`)[0]).toEqual({relation:null,owner:false});
    await apply();
  },30000);
  it('observes legacy obligation writer blocking forward DDL before atomic installation',async()=>{
    const{h,url,apply}=await setup(staged());let release!:()=>void,ready!:()=>void,holder=0;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});
    const first=h.db.transaction(async tx=>{holder=Number((await tx`select pg_backend_pid() p`)[0].p);await tx`lock table receipt_admission_obligations in row exclusive mode`;ready();await gate;});
    const sql=postgres(url.toString(),{max:1});let pending:Promise<void>|undefined;
    try{await Promise.race([started,first]);const waiter=Number((await sql`select pg_backend_pid() p`)[0].p);pending=migrate(drizzle(sql),{migrationsFolder:folder});let observed=false;
      for(let n=0;n<150;n++){if((await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) b`)[0].b){observed=true;break;}await delay(20);}expect(observed).toBe(true);
      expect((await h.db.sql`select to_regclass('public.payment_operation_evidence') relation`)[0].relation).toBeNull();release();await Promise.all([first,pending]);await apply();
    }finally{release();await Promise.allSettled([first,...(pending?[pending]:[])]);await sql.end();}
  },30000);
});
