import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DatabaseService, type DbTransaction } from '../../src/database/database.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { publishCommandObservation, publishVerifiedReceipt, signedEvidence, storeOriginalInbox, trustedEvidenceFixture, type EvidenceFixture } from '../support/trusted-evidence-fixtures';
import { captureFixture } from '../support/accounting-fixtures';

const describeDatabase=process.env.RUN_DB_TESTS==='1'?describe:describe.skip;
type Proof={inbox_id:string;proof_revision:number;contract_version:number;payment_id:string;merchant_id:string;refund_id:string|null;amount:string;currency:string;operation:string;payment_intent_id:string;owner_binding_id:string;capture_sources:unknown[]};
describeDatabase('B3.2 B.1 trusted evidence SQL foundation (financial runtime closed)',()=>{
  let db:DatabaseService;let publisher:string;let worker:string;let legacyWorker:string;
  beforeAll(async()=>{
    const value=process.env.MIGRATION_ADMIN_URL??process.env.DATABASE_URL;if(!value)throw new Error('Disposable local database URL required');
    const url=new URL(value);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Disposable local database required');
    // Deliberately PENDING evidence must not feed other suites' global legacy
    // inbox pollers. Retain a separate database instead of rewriting dispositions
    // or relying on Jest fixture order. CI's disposable PG role needs CREATEDB.
    const admin=postgres(value,{max:1}),name=`fintech_b32b1_evidence_${randomUUID().replaceAll('-','')}`;
    try{await admin.unsafe(`create database "${name}"`);}finally{await admin.end();}url.pathname=`/${name}`;
    const migration=postgres(url.toString(),{max:1});try{await migrate(drizzle(migration),{migrationsFolder:resolve(__dirname,'../../drizzle')});}finally{await migration.end();}
    const evidenceDirectory=resolve(__dirname,'../../../../.tmp');mkdirSync(evidenceDirectory,{recursive:true});writeFileSync(resolve(evidenceDirectory,'h1-b32b1-evidence-db.txt'),name+'\n');
    db=new DatabaseService(new ConfigService({DATABASE_URL:url.toString()}));
    const suffix=randomUUID().replaceAll('-','');publisher=`b1_publisher_${suffix}`;worker=`b1_worker_${suffix}`;legacyWorker=`b1_legacy_${suffix}`;
    for(const role of [publisher,worker,legacyWorker])await db.sql.unsafe(`create role "${role}" nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    for(const role of [publisher,worker,legacyWorker])await db.sql.unsafe(`grant usage on schema public to "${role}"`);
    await db.sql.unsafe(`grant select,update on public.webhook_events to "${legacyWorker}"`);
    await db.sql.unsafe(`grant select on all tables in schema public to "${publisher}","${worker}"`);
    await db.sql.unsafe(`grant insert on public.provider_financial_receipts,public.provider_financial_observations to "${publisher}"`);
    await db.sql.unsafe(`grant update (updated_at) on public.webhook_events to "${publisher}"`);
    await db.sql.unsafe(`grant update (created_at) on public.financial_evidence_accounts to "${publisher}"`);
    await db.sql.unsafe(`grant execute on function public.seal_financial_correlation(uuid,integer,uuid),public.load_effective_financial_evidence(uuid,integer,text),public.financial_receipt_facts(uuid),public.financial_external_reference(jsonb),public.assert_financial_evidence_runtime_ready() to "${worker}"`);
  },30000);
  afterAll(async()=>{await db?.onApplicationShutdown();});
  async function asRole<T>(role:string,work:(tx:DbTransaction)=>Promise<T>) {return db.transaction(async tx=>{await tx.unsafe(`set local role "${role}"`);return work(tx);});}
  async function fixture(account?:string){const f=await trustedEvidenceFixture(db,account);await asRole(publisher,tx=>publishCommandObservation(tx,f,'CAPTURE'));return f;}
  async function evidence(f:EvidenceFixture,options:Parameters<typeof signedEvidence>[1]={},refundWitness=true){
    const signed=signedEvidence(f,options),inboxId=await storeOriginalInbox(db,signed);
    await asRole(publisher,tx=>publishVerifiedReceipt(tx,f,inboxId,signed));
    const witness=refundWitness&&options.kind!=='dispute'?await asRole(publisher,tx=>publishCommandObservation(tx,f,'REFUND')):null;
    return {inboxId,signed,witness};
  }
  async function seal(inboxId:string,witness:string|null=null,revision=0){return asRole(worker,async tx=>(await tx<Proof[]>`select * from public.seal_financial_correlation(${inboxId}::uuid,${revision}::integer,${witness}::uuid)`)[0]);}
  async function read(inboxId:string,operation='refund.succeeded',revision=1){return asRole(worker,async tx=>(await tx<Proof[]>`select * from public.load_effective_financial_evidence(${inboxId}::uuid,${revision}::integer,${operation})`)[0]);}
  async function snapshot(f:EvidenceFixture){return (await db.sql`select
    (select md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by t.id),'')) from ledger_transactions t where merchant_id=${f.merchantId}) as journals,
    (select md5(coalesce(string_agg(to_jsonb(e)::text,'|' order by e.id),'')) from ledger_entries e join ledger_transactions t on t.id=e.transaction_id where t.merchant_id=${f.merchantId}) as entries,
    (select to_jsonb(l) from capture_accounting_lots l where id=${f.lotId}) as lot,
    (select to_jsonb(p) from payments p where id=${f.paymentId}) as payment,
    (select to_jsonb(r) from refunds r where id=${f.refundId}) as refund,
    (select jsonb_agg(a order by a.id) from refund_capture_allocations a where refund_id=${f.refundId}) as allocations,
    (select count(*)::integer from audit_logs where merchant_id=${f.merchantId}) as audits`)[0];}
  async function rejection(f:EvidenceFixture,inboxId:string,witness:string|null,pattern:RegExp){const before=await snapshot(f);await expect(seal(inboxId,witness)).rejects.toThrow(pattern);expect(await snapshot(f)).toEqual(before);expect(await db.sql`select inbox_id from webhook_financial_evidence where inbox_id=${inboxId}`).toHaveLength(0);}
  it('complete signed original passes one shared projection without applying any money',async()=>{
    const f=await fixture(),e=await evidence(f),before=await snapshot(f);const p=await seal(e.inboxId,e.witness);
    expect(p).toMatchObject({inbox_id:e.inboxId,proof_revision:1,contract_version:1,payment_id:f.paymentId,merchant_id:f.merchantId,refund_id:f.refundId,amount:'5000',currency:'USD',operation:'refund.succeeded',payment_intent_id:f.pi});
    expect(p.capture_sources).toHaveLength(1);expect(await read(e.inboxId)).toEqual(p);expect(await snapshot(f)).toEqual(before);
    const [r]=await db.sql`select raw_body,payload,status from provider_financial_receipts r join webhook_events w on w.id=r.inbox_id where inbox_id=${e.inboxId}`;
    expect(Buffer.from(r.raw_body as Uint8Array)).toEqual(e.signed.raw);expect(r.payload).toEqual(e.signed.payload);expect(r.status).toBe('PENDING');
  });
  it.each(['succeeded','failed'])('missing all optional refund IDs resolves %s through exact owned command result',async status=>{
    const f=await fixture(),e=await evidence(f,{status,metadata:{}});const p=await seal(e.inboxId,e.witness);
    expect(p).toMatchObject({refund_id:f.refundId,payment_id:f.paymentId,operation:status==='succeeded'?'refund.succeeded':'refund.failed'});
    expect((await db.sql`select payload->'data' as data from webhook_events where id=${e.inboxId}`)[0].data).not.toHaveProperty('refundId');
  });
  it('signed refund ID alone works without a refund result or mutable mirror',async()=>{
    const f=await fixture(),e=await evidence(f,{metadata:{refundId:f.refundId}},false);expect((await seal(e.inboxId)).refund_id).toBe(f.refundId);
  });
  it('signed accepted refund identity remains sufficient when optional PI/Charge are absent',async()=>{
    const f=await fixture(),e=await evidence(f,{metadata:{refundId:f.refundId},object:{payment_intent:null,charge:null}},false);expect((await seal(e.inboxId)).payment_intent_id).toBe(f.pi);
  });
  it.each(['needs_response','won','lost'])('dispute %s resolves from owned capture evidence without invented command',async status=>{
    const f=await fixture(),e=await evidence(f,{kind:'dispute',status,metadata:{}},false),p=await seal(e.inboxId);
    expect(p).toMatchObject({payment_id:f.paymentId,refund_id:null,operation:status==='needs_response'?'dispute.opened':'dispute.closed'});
    expect(await db.sql`select id from disputes where payment_id=${f.paymentId}`).toHaveLength(0);
  });
  it('Charge-only dispute requires and accepts qualified immutable capture-command provenance',async()=>{
    const f=await fixture(),e=await evidence(f,{kind:'dispute',metadata:{},object:{payment_intent:null}},false);expect((await seal(e.inboxId)).payment_intent_id).toBe(f.pi);
  });
  it('two captures sharing one PaymentIntent retain independent immutable journal provenance',async()=>{
    const f=await fixture(),second=await captureFixture(db,10000,300,{merchantId:f.merchantId,paymentId:f.paymentId});
    const [l]=await db.sql<{id:string}[]>`insert into capture_accounting_lots (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at)
      select ${second.attemptId},${f.paymentId},${f.merchantId},'USD',id,10000,300,9700,posted_at,posted_at from ledger_transactions where id=${second.journalId} returning id`;
    const capturePayload={...f.capturePayload,attemptId:second.attemptId,idempotencyKey:`capture:${second.attemptId}`};
    const [command]=await db.sql<{id:string}[]>`insert into outbox_events (aggregate_type,aggregate_id,event_type,payload) values ('PAYMENT_ATTEMPT',${second.attemptId},'provider.capture.requested',${db.sql.json(capturePayload)}) returning id`;
    await asRole(publisher,tx=>publishCommandObservation(tx,{...f,...second,lotId:l.id,capturePayload,captureCommandId:command.id},'CAPTURE'));
    const refundId=randomUUID(),refundPayload={...f.refundPayload,refundId,amount:12000,idempotencyKey:`refund:${refundId}`};
    await db.transaction(async tx=>{await tx`insert into refunds (id,payment_id,merchant_id,currency,amount) values (${refundId},${f.paymentId},${f.merchantId},'USD',12000)`;
      await tx`insert into refund_capture_allocations (refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross) values
        (${refundId},${f.lotId},${f.paymentId},${f.merchantId},'USD',5000),(${refundId},${l.id},${f.paymentId},${f.merchantId},'USD',7000)`;});
    const [r]=await db.sql<{id:string}[]>`insert into outbox_events (aggregate_type,aggregate_id,event_type,payload) values ('REFUND',${refundId},'provider.refund.requested',${db.sql.json(refundPayload)}) returning id`;
    const e=await evidence({...f,refundId,objectId:`re_${refundId}`,refundPayload,refundCommandId:r.id},{object:{amount:12000}},false);
    const p=await seal(e.inboxId);expect(p.payment_intent_id).toBe(f.pi);expect(p.capture_sources).toHaveLength(2);expect(p.amount).toBe('12000');
    expect(p.capture_sources).toEqual(expect.arrayContaining([expect.objectContaining({journal_id:f.journalId,gross:'10000',fee:'300',net:'9700'}),expect.objectContaining({journal_id:second.journalId})]));
  });
  it('pending provider outcome cannot be upgraded by a success label',async()=>{
    const f=await fixture(),s=signedEvidence(f,{status:'pending'});s.payload={...s.payload,type:'refund.succeeded'};
    const inboxId=await storeOriginalInbox(db,s);await asRole(publisher,tx=>publishVerifiedReceipt(tx,f,inboxId,s));
    await rejection(f,inboxId,null,/Unsupported or unconfirmed/);
  });
  it('missing refund ID without an immutable result remains unresolved',async()=>{
    const f=await fixture(),e=await evidence(f,{metadata:{}},false);await rejection(f,e.inboxId,null,/immutable owned command-result/);
  });
  it.each([true,false])('explicit signed provider-account identity must agree, matching=%s',async matching=>{
    const f=await fixture(),e=await evidence(f,{providerAccount:matching?f.account:'acct_other'});
    if(matching)expect((await seal(e.inboxId,e.witness)).payment_id).toBe(f.paymentId);else await rejection(f,e.inboxId,e.witness,/provider account contradicts/);
  });
  it('a trusted publisher still cannot publish a command snapshot inconsistent with the accepted outbox',async()=>{
    const f=await fixture();await expect(asRole(publisher,tx=>publishCommandObservation(tx,{...f,refundPayload:{...f.refundPayload,amount:4999}},'REFUND'))).rejects.toThrow(/contradicts accepted owned command/);
    expect(await db.sql`select id from provider_financial_observations where refund_id=${f.refundId}`).toHaveLength(0);
  });
  it('a normalized historical row without raw receipt is not verification',async()=>{
    const f=await fixture(),id=await storeOriginalInbox(db,signedEvidence(f));await expect(seal(id)).rejects.toThrow();expect(await db.sql`select inbox_id from webhook_financial_evidence where inbox_id=${id}`).toHaveLength(0);
  });
  it.each(['merchantId','paymentId','refundId'])('explicit contradictory %s is never overwritten',async key=>{
    const f=await fixture(),e=await evidence(f,{metadata:{merchantId:f.merchantId,paymentId:f.paymentId,refundId:f.refundId,[key]:randomUUID()}});
    await rejection(f,e.inboxId,e.witness,/contradict|no rows/i);
  });
  it.each([{payment_intent:'pi_other'},{charge:'ch_other'}])('explicit PI/Charge contradiction %j is refused',async object=>{
    const f=await fixture(),e=await evidence(f,{object});await rejection(f,e.inboxId,e.witness,/contradict/i);
  });
  it.each([{amount:4999},{currency:'eur'},{amount:1.5},{amount:9007199254740992},{amount:null},{metadata:{merchantId:''}}])('invalid original financial facts %j cannot seal',async object=>{
    const f=await fixture(),e=await evidence(f,{object});await rejection(f,e.inboxId,e.witness,/amount|currency|Malformed|Exact/i);
  });
  it('normalization disagreement fails without rewriting either original',async()=>{
    const f=await fixture(),s=signedEvidence(f);s.payload={...s.payload,data:{...s.payload.data!,amount:4999}};
    const id=await storeOriginalInbox(db,s);await asRole(publisher,tx=>publishVerifiedReceipt(tx,f,id,s));await rejection(f,id,null,/Normalized financial facts/);
  });
  it('verified raw evidence can classify a normalization-unsupported original without altering it',async()=>{
    const f=await fixture(),s=signedEvidence(f);s.payload={...s.payload,type:'provider.unsupported',data:null};const id=await storeOriginalInbox(db,s);
    await asRole(publisher,tx=>publishVerifiedReceipt(tx,f,id,s));expect((await seal(id)).operation).toBe('refund.succeeded');
    expect((await db.sql`select payload->>'type' as type from webhook_events where id=${id}`)[0].type).toBe('provider.unsupported');
  });
  it('wrong refund witness/object cannot authorize otherwise matching PI and amount',async()=>{
    const f=await fixture(),e=await evidence(f,{metadata:{}},false),other=await fixture(f.account);
    const witness=await asRole(publisher,tx=>publishCommandObservation(tx,other,'REFUND'));await rejection(f,e.inboxId,witness,/no rows/i);
  });
  it('multiple immutable owner candidates are retained as a review, never latest-match ownership',async()=>{
    const f=await fixture(),e=await evidence(f,{metadata:{}}),other=await fixture(f.account);
    await asRole(publisher,tx=>publishCommandObservation(tx,other,'REFUND',f.objectId));await rejection(f,e.inboxId,e.witness,/Multiple provider-object owner/);
    await db.sql`insert into financial_evidence_reviews (inbox_id,review_key,reason,observations) values (${e.inboxId},'owner-conflict','CONTRADICTORY',${db.sql.json({first:f.refundId,second:other.refundId})}) on conflict do nothing`;
    await db.sql`insert into financial_evidence_reviews (inbox_id,review_key,reason,observations) values (${e.inboxId},'owner-conflict','CONTRADICTORY','{}') on conflict do nothing`;
    const rows=await db.sql`select observations from financial_evidence_reviews where inbox_id=${e.inboxId}`;expect(rows).toHaveLength(1);expect(rows[0].observations).toEqual({first:f.refundId,second:other.refundId});
  });
  it('owned contradictory mirror is checked before any synchronization',async()=>{
    const f=await fixture(),e=await evidence(f);await db.sql`insert into provider_transactions (merchant_id,payment_id,refund_id,provider,provider_transaction_id,provider_idempotency_key,operation,status,amount,currency,payment_intent_id)
      values (${f.merchantId},${f.paymentId},${f.refundId},'STRIPE','re_wrong',${`refund:${f.refundId}`},'REFUND','pending',5000,'USD',${f.pi})`;
    await rejection(f,e.inboxId,e.witness,/mirror contradicts/);expect((await db.sql`select provider_transaction_id from provider_transactions where refund_id=${f.refundId}`)[0].provider_transaction_id).toBe('re_wrong');
  });
  it('a mutable PI mirror alone supplies no missing-ID witness',async()=>{
    const f=await fixture(),e=await evidence(f,{metadata:{}},false);await db.sql`insert into provider_transactions (merchant_id,payment_id,refund_id,provider,provider_transaction_id,provider_idempotency_key,operation,status,amount,currency,payment_intent_id)
      values (${f.merchantId},${f.paymentId},${f.refundId},'STRIPE',${f.objectId},${`refund:${f.refundId}`},'REFUND','succeeded',5000,'USD',${f.pi})`;
    await rejection(f,e.inboxId,null,/immutable owned command-result/);
  });
  it('a provider lookup observation cannot masquerade as an accepted refund command result',async()=>{
    const f=await fixture(),e=await evidence(f,{metadata:{}},false);
    const [o]=await asRole(publisher,tx=>tx<{id:string}[]>`insert into provider_financial_observations
      (provider,provider_account,source_kind,source_key,object_kind,provider_object_id,provider_status,snapshot,observed_at,publisher_version)
      values ('STRIPE',${f.account},'PROVIDER_LOOKUP',${randomUUID()},'REFUND',${f.objectId},'succeeded','{}',now(),'isolated-lookup/v1') returning id`);
    await rejection(f,e.inboxId,o.id,/no rows/i);
  });
  it('same event replay and a second event retain one immutable provider-object owner',async()=>{
    const f=await fixture(),a=await evidence(f),p=await seal(a.inboxId,a.witness);expect(await seal(a.inboxId,a.witness)).toEqual(p);
    const b=await evidence(f);const q=await seal(b.inboxId,b.witness);expect(q.owner_binding_id).toBe(p.owner_binding_id);
    expect(await db.sql`select id from provider_financial_object_owners where provider_object_id=${f.objectId} and provider_account=${f.account}`).toHaveLength(1);
  });
  it.each([{revision:2,operation:'refund.succeeded'},{revision:0,operation:'refund.succeeded'},{revision:1,operation:'refund.failed'}])('incompatible proof request %j fails',async option=>{
    const f=await fixture(),e=await evidence(f);await seal(e.inboxId,e.witness);await expect(read(e.inboxId,option.operation,option.revision)).rejects.toThrow(/Missing or incompatible/);
  });
  it('another inbox cannot use the first event proof',async()=>{
    const f=await fixture(),a=await evidence(f),b=await evidence(f);await seal(a.inboxId,a.witness);await expect(read(b.inboxId)).rejects.toThrow(/Missing/);
  });
  it('replay cannot substitute an unrelated immutable observation before its early return',async()=>{
    const f=await fixture(),e=await evidence(f),p=await seal(e.inboxId,e.witness),other=await fixture(f.account);
    const wrong=await asRole(publisher,tx=>publishCommandObservation(tx,other,'REFUND'));await expect(seal(e.inboxId,wrong)).rejects.toThrow(/Replay observation contradicts/);expect(await read(e.inboxId)).toEqual(p);
  });
  it('immutable proof remains unchanged throughout a reader transaction despite a concurrent rejected edit',async()=>{
    const f=await fixture(),e=await evidence(f);await seal(e.inboxId,e.witness);
    await asRole(worker,async tx=>{const before=(await tx`select * from load_effective_financial_evidence(${e.inboxId},1,'refund.succeeded')`)[0];
      await expect(db.sql`update webhook_financial_evidence set merchant_id=${randomUUID()} where inbox_id=${e.inboxId}`).rejects.toThrow(/immutable/);
      expect((await tx`select * from load_effective_financial_evidence(${e.inboxId},1,'refund.succeeded')`)[0]).toEqual(before);});
  });
  it('attempt generation mismatch refuses correlation',async()=>{const f=await fixture(),e=await evidence(f);await expect(seal(e.inboxId,e.witness,1)).rejects.toThrow(/revision changed/);});
  it('sealer rejects an unsupported repeatable-read snapshot instead of certifying stale discovery',async()=>{
    const f=await fixture(),e=await evidence(f);await expect(db.transaction(async tx=>{await tx`set transaction isolation level repeatable read`;
      await tx.unsafe(`set local role "${worker}"`);await tx`select public.seal_financial_correlation(${e.inboxId},0,${e.witness})`;})).rejects.toThrow(/requires READ COMMITTED/);
    expect(await db.sql`select inbox_id from webhook_financial_evidence where inbox_id=${e.inboxId}`).toHaveLength(0);
  });
  it.each(['provider_financial_receipts','provider_financial_observations','provider_financial_object_owners','webhook_financial_evidence','financial_evidence_accounts','financial_evidence_reviews'])('%s rejects normal UPDATE/DELETE/TRUNCATE',async table=>{
    const f=await fixture(),e=await evidence(f);await seal(e.inboxId,e.witness);
    if(table==='financial_evidence_reviews')await db.sql`insert into financial_evidence_reviews (inbox_id,review_key,reason,observations) values (${e.inboxId},'immutable-test','UNRESOLVED','{}')`;
    await expect(db.sql.unsafe(`update public.${table} set ${table==='webhook_financial_evidence'?'proof_revision=2':table==='provider_financial_receipts'?'signature=signature':table==='financial_evidence_reviews'?'reason=reason':'provider=provider'}`)).rejects.toThrow(/immutable/i);
    await expect(db.sql.unsafe(`delete from public.${table}`)).rejects.toThrow(/immutable/i);
    await expect(db.sql.unsafe(`truncate public.${table} cascade`)).rejects.toThrow(/immutable/i);
  });
  it('receipt headers and exact bytes stay protected while mutable inbox status can change',async()=>{
    const f=await fixture(),e=await evidence(f);await expect(db.sql`update webhook_events set headers='{"changed":true}' where id=${e.inboxId}`).rejects.toThrow(/immutable/);
    await db.sql`update webhook_events set status='RETRY' where id=${e.inboxId}`;expect((await db.sql`select status from webhook_events where id=${e.inboxId}`)[0].status).toBe('RETRY');
  });
  it('legacy status-only worker needs no new receipt permissions and cannot mutate retained headers',async()=>{
    const f=await fixture(),e=await evidence(f);
    expect((await db.sql`select has_table_privilege(${legacyWorker},'public.provider_financial_receipts','SELECT') as allowed`)[0].allowed).toBe(false);
    await asRole(legacyWorker,tx=>tx`update webhook_events set status='RETRY' where id=${e.inboxId}`);
    await expect(asRole(legacyWorker,tx=>tx`update webhook_events set headers='{"changed":true}' where id=${e.inboxId}`)).rejects.toThrow(/immutable/);
  });
  it('receipt publication invalidates a stale repeatable-read header writer without changing inbox timestamps',async()=>{
    const f=await fixture(),signed=signedEvidence(f),inboxId=await storeOriginalInbox(db,signed);
    const [before]=await db.sql`select updated_at::text,headers from webhook_events where id=${inboxId}`;
    await expect(db.transaction(async tx=>{await tx`set transaction isolation level repeatable read`;
      await tx`select id,headers from webhook_events where id=${inboxId}`;
      await asRole(publisher,t=>publishVerifiedReceipt(t,f,inboxId,signed));
      await tx`update webhook_events set headers='{"stale":true}' where id=${inboxId}`;
    })).rejects.toMatchObject({code:'40001'});
    expect((await db.sql`select updated_at::text,headers from webhook_events where id=${inboxId}`)[0]).toEqual(before);
    expect(await db.sql`select inbox_id from provider_financial_receipts where inbox_id=${inboxId}`).toHaveLength(1);
  });
  it('ordinary worker has no receipt/proof/binding publishing or ledger mutation capability',async()=>{
    const f=await fixture(),e=await evidence(f);
    await expect(asRole(worker,tx=>publishVerifiedReceipt(tx,f,e.inboxId,e.signed))).rejects.toThrow(/permission denied/);
    await expect(asRole(worker,tx=>tx`insert into webhook_financial_evidence (inbox_id) values (${e.inboxId})`)).rejects.toThrow(/permission denied/);
    await expect(asRole(worker,tx=>tx`insert into provider_financial_object_owners (provider) values ('STRIPE')`)).rejects.toThrow(/permission denied/);
    const [roles]=await db.sql`select rolname,rolsuper,rolcanlogin,rolcreaterole,rolbypassrls,
      has_table_privilege(oid,'public.ledger_entries','INSERT') as ledger_insert,has_table_privilege(oid,'public.ledger_transactions','UPDATE') as ledger_update
      from pg_roles where rolname='fintech_evidence_'||md5(current_database())`;
    expect(roles).toMatchObject({rolsuper:false,rolcanlogin:false,rolcreaterole:false,rolbypassrls:false,ledger_insert:false,ledger_update:false});
    const ownerName='fintech_evidence_'+(await db.sql<{value:string}[]>`select md5(current_database()) as value`)[0].value;
    for(const table of ['ledger_transactions','ledger_entries'])for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE'])
      expect((await db.sql`select has_table_privilege(${ownerName},${'public.'+table},${privilege}) as allowed`)[0].allowed).toBe(false);
    expect((await db.sql`select pg_has_role(${worker},${ownerName},'MEMBER') as allowed`)[0].allowed).toBe(false);
    expect((await seal(e.inboxId,e.witness)).refund_id).toBe(f.refundId);
  });
  it('unrelated ordinary role cannot execute the sealer through PUBLIC defaults',async()=>{
    const f=await fixture(),e=await evidence(f);await expect(asRole(publisher,tx=>tx`select public.seal_financial_correlation(${e.inboxId},0,null)`)).rejects.toThrow(/permission denied/);
  });
  it.each([1,null])('new-contract version %s cannot finalize through the closed legacy floor',async version=>{
    const f=await fixture(),e=await evidence(f),before=await snapshot(f);await seal(e.inboxId,e.witness);
    await expect(db.transaction(async tx=>{
      const ledger=new LedgerService(db),j=await ledger.post(tx,{merchantId:f.merchantId,businessType:'REFUND',businessId:f.refundId,currency:'USD',description:'Must rollback at closed contract floor',lines:[
        {accountCode:'MERCHANT_PENDING',merchantId:f.merchantId,debit:4850},{accountCode:'PLATFORM_FEE_REFUNDS',merchantId:null,debit:150},{accountCode:'PSP_CLEARING',merchantId:null,credit:5000}]});
      await tx`update refund_capture_allocations set status='CONFIRMED',confirmed_gross=5000,confirmed_fee=150,journal_id=${j},provider_event_id=${e.inboxId},evidence_contract_version=${version},proof_revision=1 where refund_id=${f.refundId}`;
    })).rejects.toThrow(/floor_closed|not-null/i);expect(await snapshot(f)).toEqual(before);
  });
  it('version0 plus proof, runtime readiness and ACTIVE all fail closed',async()=>{
    const f=await fixture(),e=await evidence(f);await seal(e.inboxId,e.witness);
    await expect(db.sql`update refund_capture_allocations set proof_revision=1 where refund_id=${f.refundId}`).rejects.toThrow(/floor_closed/);
    await expect(asRole(worker,tx=>tx`select public.assert_financial_evidence_runtime_ready()`)).rejects.toThrow(/UNINSTALLED/);
    await expect(db.sql`update capture_accounting_scopes set status='ACTIVE' where merchant_id=${f.merchantId}`).rejects.toThrow(/check constraint/);
    expect((await db.sql`select count(*)::integer as count from capture_accounting_scopes where status='ACTIVE'`)[0].count).toBe(0);
  });
  it('sealer rollback leaves only separately committed original evidence',async()=>{
    const f=await fixture(),e=await evidence(f),before=await snapshot(f);
    await expect(asRole(worker,async tx=>{await tx`select public.seal_financial_correlation(${e.inboxId},0,${e.witness})`;throw new Error('ordinary rollback');})).rejects.toThrow('ordinary rollback');
    expect(await db.sql`select inbox_id from webhook_financial_evidence where inbox_id=${e.inboxId}`).toHaveLength(0);
    expect(await db.sql`select id from provider_financial_object_owners where provider_object_id=${f.objectId} and provider_account=${f.account}`).toHaveLength(0);
    expect(await db.sql`select inbox_id from provider_financial_receipts where inbox_id=${e.inboxId}`).toHaveLength(1);expect(await snapshot(f)).toEqual(before);
  });
  it('F02 deferred commit failure rolls back a newly sealed proof and binding',async()=>{
    const f=await fixture(),e=await evidence(f),before=await snapshot(f);await expect(db.transaction(async tx=>{
      await tx`select public.seal_financial_correlation(${e.inboxId},0,${e.witness})`;
      const [a]=await tx<{id:string}[]>`insert into ledger_accounts (code,name,account_type,currency) values (${`ISOLATED_${randomUUID()}`},'Isolated deferred-constraint fixture','ASSET','USD') returning id`;
      const [j]=await tx<{id:string}[]>`insert into ledger_transactions (merchant_id,business_type,business_id,currency,status,description) values (${f.merchantId},'ISOLATED_DEFERRED',${randomUUID()},'USD','DRAFT','Must fail deferred balance check') returning id`;
      await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) values (${j.id},${a.id},'USD',10,0)`;
      await tx`update ledger_transactions set status='POSTED',posted_at=now() where id=${j.id}`;
    })).rejects.toThrow(/balanced/);expect(await snapshot(f)).toEqual(before);expect(await db.sql`select inbox_id from webhook_financial_evidence where inbox_id=${e.inboxId}`).toHaveLength(0);
  });
  async function waitForBlock(waiter:number,blocker:number){for(let i=0;i<160;i++){const [r]=await db.sql<{blocked:boolean}[]>`select ${blocker}=any(pg_blocking_pids(${waiter})) as blocked`;if(r.blocked)return;await delay(20);}throw new Error('Expected actual PostgreSQL blocker was not observed');}
  it.each([false,true])('two sealer workers serialize on one private inbox, reversed=%s',async reversed=>{
    const f=await fixture(),e=await evidence(f);let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});let pid1=0,pid2=0;
    const first=db.transaction(async tx=>{pid1=(await tx<{pid:number}[]>`select pg_backend_pid() as pid`)[0].pid;await tx.unsafe(`set local role "${worker}"`);
      const p=(await tx<Proof[]>`select * from public.seal_financial_correlation(${e.inboxId},0,${reversed?null:e.witness})`)[0];ready();await gate;return p;});
    let second:Promise<Proof>|undefined;
    try{await Promise.race([started,first]);second=db.transaction(async tx=>{pid2=(await tx<{pid:number}[]>`select pg_backend_pid() as pid`)[0].pid;await tx.unsafe(`set local role "${worker}"`);return (await tx<Proof[]>`select * from public.seal_financial_correlation(${e.inboxId},0,${reversed?e.witness:null})`)[0];});
      const outcomes=Promise.allSettled([first,second]);for(let i=0;!pid2&&i<200;i++)await delay(1);if(!pid2)throw new Error('Second backend PID not established');
      await waitForBlock(pid2,pid1);release();const results=await outcomes;expect(results.map(r=>r.status)).toEqual(['fulfilled','fulfilled']);
      if(results[0].status==='fulfilled'&&results[1].status==='fulfilled')expect(results[0].value).toEqual(results[1].value);
    }finally{release();await Promise.allSettled([first,...(second?[second]:[])]);}
    expect(await db.sql`select inbox_id from webhook_financial_evidence where inbox_id=${e.inboxId}`).toHaveLength(1);
  });
  it.each([false,true])('conflicting cross-scope object claims serialize and retain one original owner, reversed=%s',async reversed=>{
    const f=await fixture(),other=await fixture(f.account),a=await evidence(f,{},false),b=await evidence(other,{object:{id:f.objectId}},false);
    const firstEvent=reversed?b:a,secondEvent=reversed?a:b,firstOwner=reversed?other:f;
    let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});let pid1=0,pid2=0;
    const first=db.transaction(async tx=>{pid1=(await tx<{pid:number}[]>`select pg_backend_pid() as pid`)[0].pid;await tx.unsafe(`set local role "${worker}"`);await tx`select public.seal_financial_correlation(${firstEvent.inboxId},0,null)`;ready();await gate;});
    let second:Promise<unknown>|undefined;
    try{await Promise.race([started,first]);second=asRole(worker,async tx=>{pid2=(await tx<{pid:number}[]>`select pg_backend_pid() as pid`)[0].pid;return tx`select public.seal_financial_correlation(${secondEvent.inboxId},0,null)`;});
      const outcomes=Promise.allSettled([first,second]);for(let i=0;!pid2&&i<200;i++)await delay(1);if(!pid2)throw new Error('Second backend PID not established');
      await waitForBlock(pid2,pid1);release();const results=await outcomes;
      expect(results[0].status).toBe('fulfilled');expect(results[1].status).toBe('rejected');if(results[1].status==='rejected')expect((results[1].reason as Error).message).toMatch(/already bound/);
    }finally{release();await Promise.allSettled([first,...(second?[second]:[])]);}
    expect((await db.sql`select payment_id from provider_financial_object_owners where provider_account=${f.account} and provider_object_id=${f.objectId}`)[0].payment_id).toBe(firstOwner.paymentId);
    expect(await db.sql`select inbox_id from webhook_financial_evidence where inbox_id=${secondEvent.inboxId}`).toHaveLength(0);
    await db.sql`insert into financial_evidence_reviews (inbox_id,review_key,reason,observations) values (${secondEvent.inboxId},'object-owner','CONTRADICTORY',${db.sql.json({preservedOwner:firstOwner.paymentId})})`;
    for(const item of [f,other])expect((await db.sql`select count(*)::integer as count from ledger_transactions where merchant_id=${item.merchantId} and business_type='REFUND'`)[0].count).toBe(0);
  });
  it('uncommitted proof is unreadable and runtime application remains blocked after commit',async()=>{
    const f=await fixture(),e=await evidence(f);let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});
    const sealing=db.transaction(async tx=>{await tx`select public.seal_financial_correlation(${e.inboxId},0,${e.witness})`;ready();await gate;});
    try{await Promise.race([started,sealing]);await expect(read(e.inboxId)).rejects.toThrow(/Missing/);}finally{release();await sealing;}
    expect((await read(e.inboxId)).inbox_id).toBe(e.inboxId);await expect(db.sql`select public.assert_financial_evidence_runtime_ready()`).rejects.toThrow(/UNINSTALLED/);
  });
});
