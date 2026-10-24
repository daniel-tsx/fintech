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
describeMigration('P-A forward migration preserves legacy REFUND evidence and guards', () => {
  const folder = resolve(__dirname,'../../drizzle'), all: Awaited<ReturnType<typeof providerObservationHarness>>[] = [];
  function staged(count = 12, failure = false) {
    const target = resolve(__dirname,`../../../../.tmp/pa-migrations-${randomUUID()}`); mkdirSync(resolve(target,'meta'),{recursive:true});
    const journal = JSON.parse(readFileSync(resolve(folder,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string}[]};
    journal.entries=journal.entries.filter(e=>e.idx<count); writeFileSync(resolve(target,'meta/_journal.json'),JSON.stringify(journal));
    for (const e of journal.entries) copyFileSync(resolve(folder,e.tag+'.sql'),resolve(target,e.tag+'.sql'));
    if (failure) { const p=resolve(target,'0012_shared_payment_proof_envelope.sql'); writeFileSync(p,readFileSync(p,'utf8')+"\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'planned P-A rollback'; END $$;\n"); }
    return target;
  }
  async function setup(source = folder) {
    const h=await providerObservationHarness(source); all.push(h); const url=new URL(process.env.MIGRATION_ADMIN_URL!); url.pathname='/'+String((await h.db.sql`select current_database() n`)[0].n);
    async function apply(from=folder) { const sql=postgres(url.toString(),{max:1}); try { await migrate(drizzle(sql),{migrationsFolder:from}); } finally { await sql.end(); } }
    return {h,url,apply};
  }
  afterAll(async()=>{for(const h of all)await h.close();});
  async function legacy(h: Awaited<ReturnType<typeof providerObservationHarness>>) {
    const f=await h.accepted(); await h.db.transaction(tx=>publishCommandObservation(tx,f,'CAPTURE')); await(await f.producer.execute(f.message)).publish();
    await h.db.sql`insert into refund_capture_allocations(refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross) values(${f.operationId},${f.lotId},${f.paymentId},${f.merchantId},'USD',2000)`;
    const signed=signedEvidence({...f,refundId:f.operationId,objectId:f.object.id},{object:{amount:2000}}),attested=h.sign(signed.raw);
    const receipt=await h.receiver(f.account).receive(attested.raw,attested.signature); expect(await h.correlate(f.account).correlate(receipt.id)).toMatchObject({state:'BOUND'});
    const [root]=await h.db.sql<{id:string}[]>`insert into financial_application_roots(family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,refund_id)
      values('REFUND',${f.operationId},'TERMINAL',${f.merchantId},'USD','STRIPE',${f.account},'LEGACY',0,${f.outboxId},${f.paymentId},${f.operationId}) returning id`;
    async function insert(inbox = receipt.id) {
      return h.db.sql`insert into financial_application_manifests(root_id,transaction_id,backend_pid,inbox_id,proof_revision,proof_operation,claim_generation,merchant_id,currency,payment_id,
        policy,epoch,scope_revision,intake_revision,contract_version,result,source_manifest,effect_manifest)
        values(${root.id},pg_current_xact_id(),pg_backend_pid(),${inbox},1,'refund.succeeded',0,${f.merchantId},'USD',${f.paymentId},
          'LEGACY',0,0,0,1,'ZERO_EFFECT','{}','[]') returning id`;
    }
    const [manifest]=await insert(); return {...f,inboxId:receipt.id,manifestId:String(manifest.id),insert};
  }
  async function fingerprint(sql: Sql) {
    const result: Record<string,unknown>={};
    for(const table of ['financial_application_roots','financial_application_manifests','webhook_financial_evidence','payment_operation_evidence','provider_observation_sources','provider_command_executions','ledger_transactions','ledger_entries','refund_capture_allocations'])
      result[table]=(await sql.unsafe(`select md5(coalesce(string_agg(j,'|' order by j),'')) hash from (select (to_jsonb(t)-'proof_kind'-'payment_operation_proof_id'-'legacy_proof_inbox_id'-'payment_proof_inbox_id')::text j from ${table} t) s`))[0].hash;
    result.guards=await sql`select p.proname,pg_get_functiondef(p.oid) body,p.proacl::text acl from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in
      ('prepare_financial_application','validate_financial_application','complete_financial_application','financial_application_effect_owners','guard_financial_application_effect','check_financial_application_effect_finality','load_effective_payment_operation_evidence') order by p.proname`;
    result.acls=await sql`select c.relname,coalesce(r.rolname,'PUBLIC') grantee,x.privilege_type,x.is_grantable,x.grantor::regrole::text grantor
      from pg_class c cross join lateral aclexplode(c.relacl) x left join pg_roles r on r.oid=x.grantee
      where c.oid in ('financial_application_manifests'::regclass,'webhook_financial_evidence'::regclass,'payment_operation_evidence'::regclass)
        and coalesce(r.rolname,'PUBLIC')<>'fintech_proof_envelope_'||md5(current_database()) order by c.relname,grantee,x.privilege_type`;
    result.triggers=await sql`select tgname,pg_get_triggerdef(oid) body from pg_trigger where tgrelid='financial_application_manifests'::regclass and not tgisinternal and tgname<>'application_payment_proof' order by tgname`;
    return result;
  }
  it('fresh thirteen-migration install is repeatable, empty and closed', async()=>{
    const{h,apply}=await setup(); await apply(); expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(13);
    for(const table of ['financial_application_contracts','financial_application_scope_authority','financial_application_manifests','financial_application_permits','financial_applications','financial_application_dispositions'])expect(await h.db.sql.unsafe(`select 1 from ${table}`)).toHaveLength(0);
  },30000);
  it('populated0011 upgrade retains exact original fields, ACLs, triggers, readers and REFUND default/FK', async()=>{
    const{h,apply}=await setup(staged()),f=await legacy(h),before=await fingerprint(h.db.sql); await apply(); await apply(); expect(await fingerprint(h.db.sql)).toEqual(before);
    expect((await h.db.sql`select proof_kind,legacy_proof_inbox_id,payment_proof_inbox_id,payment_operation_proof_id from financial_application_manifests where id=${f.manifestId}`)[0])
      .toEqual({proof_kind:'REFUND_V1',legacy_proof_inbox_id:f.inboxId,payment_proof_inbox_id:null,payment_operation_proof_id:null});
    await f.insert();
    await expect(f.insert(randomUUID())).rejects.toMatchObject({code:'23503'});
    await expect(h.db.sql`update financial_application_manifests set proof_kind=proof_kind where id=${f.manifestId}`).rejects.toThrow(/immutable/i);
    expect(await h.correlate(f.account).correlate(f.inboxId)).toMatchObject({state:'BOUND'});
  },30000);
  it('late0012 failure restores the exact old catalog/data/owner state before a successful retry',async()=>{
    const{h,apply}=await setup(staged()); await legacy(h); const before=await fingerprint(h.db.sql); let error:unknown;
    try{await apply(staged(13,true));}catch(e){error=e;} expect((error as {cause:Error}).cause.message).toMatch(/planned P-A rollback/);
    expect(await fingerprint(h.db.sql)).toEqual(before);
    expect((await h.db.sql`select exists(select 1 from pg_attribute where attrelid='financial_application_manifests'::regclass and attname='proof_kind' and not attisdropped) added,
      to_regprocedure('public.check_payment_proof_envelope()') checker,exists(select 1 from pg_roles where rolname='fintech_proof_envelope_'||md5(current_database())) owner`)[0]).toEqual({added:false,checker:null,owner:false});
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(12); await apply();
  },30000);
  it('observes a distinct backend waiting on a manifest writer without partial new branch visibility',async()=>{
    const{h,url,apply}=await setup(staged()); await legacy(h); let release!:()=>void,ready!:()=>void,holder=0;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});
    const first=h.db.transaction(async tx=>{holder=Number((await tx`select pg_backend_pid() p`)[0].p);await tx`lock table financial_application_manifests in row exclusive mode`;ready();await gate;});
    const sql=postgres(url.toString(),{max:1});let pending:Promise<void>|undefined;
    try{await Promise.race([started,first]);const waiter=Number((await sql`select pg_backend_pid() p`)[0].p);expect(waiter).not.toBe(holder);pending=migrate(drizzle(sql),{migrationsFolder:folder});let observed=false;
      for(let n=0;n<150;n++){if((await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) b`)[0].b){observed=true;break;}await delay(20);}expect(observed).toBe(true);
      expect((await h.db.sql`select exists(select 1 from pg_attribute where attrelid='financial_application_manifests'::regclass and attname='proof_kind' and not attisdropped) added`)[0].added).toBe(false);
      release();await Promise.all([first,pending]);await apply();
    }finally{release();await Promise.allSettled([first,...(pending?[pending]:[])]);await sql.end();}
  },30000);
});
