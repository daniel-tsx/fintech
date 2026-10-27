import { setTimeout as delay } from 'node:timers/promises';
import type { TransactionSql } from 'postgres';
import { capturePreparationHarness, type CapturePreparationRequest } from '../support/capture-preparation-harness';
import type { IntentVariant } from '../support/first-capture-intent-harness';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { ScriptedStripeHttp } from '../support/provider-observation-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30000);
describeDb('B2-A rollback-only capture preparation', () => {
  let h: Awaited<ReturnType<typeof capturePreparationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  beforeAll(async () => { h = await capturePreparationHarness(); await h.install(); });
  afterAll(async () => { if (h) await h.close(); });
  async function refused(f: Fixture, request?: CapturePreparationRequest) {
    const before = await h.captureState(f);
    await expect(h.inspectPlan(f, request)).rejects.toThrow();
    expect(await h.captureState(f)).toEqual(before);
  }
  async function waitFor(blocker: number, waiter: number) {
    expect(blocker).not.toBe(waiter);
    for (let n = 0; n < 150; n++) {
      if ((await h.db.sql`select ${blocker}=any(pg_blocking_pids(${waiter})) blocked`)[0].blocked) return;
      await delay(20);
    }
    throw new Error('Expected capture preparation lock wait was not observed');
  }
  it.each<[IntentVariant, number, number]>([['FULL',10000,300],['FIRST_PARTIAL',4000,120],['FINAL_PARTIAL',4000,120]])
   ('derives %s from genuine P-B/P-C/D02/signed B1 and leaves every blocker intact', async (variant, gross, fee) => {
      const f = await h.fixture({ variant, gross }), before = await h.captureState(f), plan = await h.inspectPlan(f);
      expect(plan).toMatchObject({ proof_kind:'PAYMENT_OPERATION_V1',result:'POSTED',payment_operation_proof_id:f.capture.proofId,
        source_manifest:{contract:'CAPTURE_PREPARATION_V1',executable:false,money:{C0:0,F0:0,C1:gross,F1:fee,gross,fee,net:gross-fee}} });
      expect(plan.source_manifest.inventory.receipts).toHaveLength(1); expect(plan.source_manifest.inventory.sources).toHaveLength(1);
      expect(plan.source_manifest.inventory.authorization_causes).toHaveLength(2);
      expect(plan.effect_manifest.find(e=>e.kind==='journal')).toMatchObject({business_type:'CAPTURE',business_id:f.accepted.body.attemptId,
        lines:[{code:'PSP_CLEARING',owner:null,type:'ASSET',currency:'USD',debit:gross,credit:0},
          {code:'MERCHANT_PENDING',owner:f.merchantId,type:'LIABILITY',currency:'USD',debit:0,credit:gross-fee},
          {code:'PLATFORM_FEE_REVENUE',owner:null,type:'REVENUE',currency:'USD',debit:0,credit:fee}]});
      const lot=plan.effect_manifest.find(e=>e.kind==='lot')!;
      expect(lot).toMatchObject({origin:'NEW_CAPTURE',status:'UNSETTLED',allocation_revision:0,gross,fee,net:gross-fee});
      expect(new Date(String(lot.eligible_at)).getTime()-new Date(String(lot.financial_captured_at)).getTime()).toBe(172800000);
      expect(await h.captureState(f)).toEqual(before);
      expect(before).toMatchObject({roots:1,manifests:1,applications:1,preparations:0,links:0,lots:0,journals:0,
        payment:{status:'CAPTURE_PENDING',captured_amount:0,platform_fee_amount:0},inbox:{status:'PROCESSING',attempts:1}});
      await expect(h.inspect(f)).rejects.toThrow(/blocked/);
    });
  it.each([[1,300,'0',0],[100,0,'200',100],[4000,300,'30',150],[333,333,'7',18],[9007199254740991,0,'0',0]] as const)
   ('uses the approved exact formula for gross=%s bps=%s fixed=%s',async(gross,bps,fixed,fee)=>{
      const f=await h.fixture({authorized:gross,bps,fixed,currency:'EUR'}), p=await h.inspectPlan(f);
      expect(p.source_manifest.money).toMatchObject({gross,fee,net:gross-fee});
      const journal=p.effect_manifest.find(e=>e.kind==='journal')!;
      expect(journal.lines).toHaveLength(1+Number(gross-fee>0)+Number(fee>0));
    });
  it.each([{authorized:9007199254740991,bps:300},{fixed:'9007199254740991'},{fixed:'-1'},{days:-1},{days:2147483647}])
   ('refuses unsafe terms or intermediates %j without partial authority',async options=>{
      const f=await h.fixture(options); await refused(f);
    });
  it('uses one SQL merchant-term snapshot even if terms change after preparation',async()=>{
    const f=await h.fixture(), r=await h.captureRevisions(f), rollback=new Error('rollback');
    try { await h.worker.sql.begin(async tx=>{
      await h.prepareCapture(tx,r);
      await h.db.sql`update merchants set fee_bps=500,fixed_fee_minor=12 where id=${f.merchantId}`;
      expect((await h.readCapture(tx))[0].plan.source_manifest.money.fee).toBe(300); throw rollback;
    }); } catch(error){if(error!==rollback)throw error;}
    expect((await h.inspectPlan(f)).source_manifest.money.fee).toBe(512);
  });
  it.each(['intent','inbox','proof','generation','obligation','scope','intake'] as const)('refuses wrong or stale %s',async key=>{
    const f=await h.fixture(), r=await h.captureRevisions(f);
    await refused(f,{...r,[key]:key==='generation'?0:['obligation','scope','intake'].includes(key)?'-1':h.randomUUID()});
  });
  it('does not confuse frozen B1 seal generation/revision with the later claim and binding',async()=>{
    const f=await h.fixture(), [proof]=await h.db.sql`select attempt_generation,receipt_revision from payment_operation_evidence where id=${f.capture.proofId}`;
    expect(proof).toEqual({attempt_generation:0,receipt_revision:'0'}); expect(f.generation).toBe(1);
    expect((await h.captureRevisions(f)).obligation).toBe('1'); await h.inspectPlan(f);
  });
  it('requires a genuine claim from this session principal',async()=>{
    const f=await h.fixture(), stranger=await h.login('capture_stranger');
    await h.db.sql.unsafe(`grant execute on function public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint) to "${stranger.role}"`);
    await expect(h.inspectPlan(f,await h.captureRevisions(f),stranger.sql)).rejects.toThrow(/genuine capture claim/);
    await expect(h.worker.sql`select public.claim_capture_preparation(${f.capture.inboxId})`).rejects.toThrow(/not claimable/);
    await expect(h.worker.sql`select public.fail_manual_authorization(${f.capture.inboxId},${f.generation})`).rejects.toThrow(/AUTH claim/);
  });
  it('commits only a bounded nonterminal capture claim using the existing P-B witness',async()=>{
    const f=await h.fixture({claim:false}), before=await h.captureState(f);
    await refused(f);
    expect((await h.worker.sql`select public.claim_capture_preparation(${f.capture.inboxId}) n`)[0].n).toBe(1);
    const after=await h.captureState(f);
    expect(after.payment).toEqual(before.payment); expect(after.receipts).toEqual(before.receipts); expect(after.sources).toEqual(before.sources);
    expect(after.scope).toEqual(before.scope); expect(after).toMatchObject({preparations:0,journals:0,lots:0,inbox:{status:'PROCESSING',attempts:1}});
  });
  it.each(['repeatable read','serializable'])('refuses %s isolation',async isolation=>{
    const f=await h.fixture(), r=await h.captureRevisions(f);
    await expect(h.worker.sql.begin(async tx=>{await tx.unsafe(`set transaction isolation level ${isolation}`);await h.prepareCapture(tx,r);})).rejects.toThrow(/READ COMMITTED/);
  });
  it.each([false,true])('refuses preparation at %s constraint timing, even with all effect groups omitted',async immediate=>{
    const f=await h.fixture(), r=await h.captureRevisions(f), before=await h.captureState(f);
    await expect(h.worker.sql.begin(async tx=>{await h.prepareCapture(tx,r);if(immediate)await tx`set constraints all immediate`;}))
      .rejects.toThrow(/cannot commit before B2-B/);
    expect(await h.captureState(f)).toEqual(before);
  });
  it('cannot autocommit preparation',async()=>{
    const f=await h.fixture(),r=await h.captureRevisions(f);
    await expect(h.worker.sql`select public.prepare_capture_application(${r.intent},${r.inbox},${r.proof},${r.generation},${r.obligation},${r.scope},${r.intake})`)
      .rejects.toThrow(/cannot commit before B2-B/);
  });
  it.each(['current_financial_application_manifest','complete_financial_application','advance_financial_application_revision','apply_manual_authorization','current_first_capture_intent'])
   ('a genuine capture preparation cannot authorize %s',async fn=>{
      const f=await h.fixture(), r=await h.captureRevisions(f), before=await h.captureState(f);
      // Grant EXECUTE only in the disposable fixture to reach the actual closed consumer.
      await h.db.sql.unsafe(`grant execute on function public.${fn}() to "${h.worker.role}"`);
      await expect(h.worker.sql.begin(async tx=>{await h.prepareCapture(tx,r);await tx.unsafe(`select public.${fn}()`);})).rejects.toThrow();
      expect(await h.captureState(f)).toEqual(before);
    });
  it.each(['capture_preparation_issuances','financial_application_roots','financial_application_manifests','financial_application_permits','financial_application_contracts','financial_application_scope_authority'])
   ('ordinary callers cannot forge %s',async table=>{
      await expect(h.ordinary.sql.unsafe(`insert into public.${table} default values`)).rejects.toMatchObject({code:'42501'});
    });
  it('savepoint rollback destroys current authority and a fresh preparation reuses only the accepted business identity',async()=>{
    const f=await h.fixture(),r=await h.captureRevisions(f),rollback=new Error('rollback');
    try {await h.worker.sql.begin(async tx=>{
      let first=''; try{await tx.savepoint(async sub=>{first=(await h.prepareCapture(sub,r))[0].id;throw rollback;});}catch(e){if(e!==rollback)throw e;}
      await expect(tx.savepoint(sub=>h.readCapture(sub))).rejects.toThrow();
      const second=(await h.prepareCapture(tx,r))[0].id;expect(second).not.toBe(first);
      expect((await h.readCapture(tx))[0].plan.id).toBe(second);throw rollback;
    });}catch(error){if(error!==rollback)throw error;}
    await h.inspectPlan(f);
  });
  it('one transaction cannot prepare a second operation and no plan survives another backend',async()=>{
    const f=await h.fixture(),r=await h.captureRevisions(f);
    await expect(h.worker.sql.begin(async tx=>{await h.prepareCapture(tx,r);await h.prepareCapture(tx,r);})).rejects.toThrow(/no other financial history|One protected operation/);
    await expect(h.peer`select public.read_capture_preparation()`).rejects.toThrow();
    await h.inspectPlan(f);await expect(h.worker.sql`select public.read_capture_preparation()`).rejects.toThrow();
  });
  it('enumerates distinct equivalent bound receipts and exact same-key direct results without clearing either',async()=>{
    const f=await h.fixture(), equivalent=await h.captureEvidence(f,f.accepted),before=await h.captureState(f),plan=await h.inspectPlan(f);
    expect(plan.source_manifest.inventory.receipts).toHaveLength(2);expect(plan.source_manifest.inventory.sources).toHaveLength(2);
    expect(await h.captureState(f)).toEqual(before);
    expect((await h.db.sql`select disposition from receipt_admission_obligations where inbox_id=${equivalent.inboxId}`)[0].disposition).toBe('AWAITING_APPLICATION');
    await expect(h.inspect(f)).rejects.toThrow(/blocked/);
  });
  it('an unbound equivalent receipt remains an independent blocker',async()=>{
    const f=await h.fixture(),event={...f.event,id:`evt_${h.randomUUID()}`,type:'payment_intent.succeeded',request:{id:`req_${f.accepted.body.attemptId}`,idempotency_key:`capture:${f.accepted.body.attemptId}`},data:{object:f.capture.object}};
    await f.receive(event);await refused(f);
  });
  it('a causally related signed contradiction after binding invalidates the proof',async()=>{
    const f=await h.fixture(),event={...f.event,id:`evt_${h.randomUUID()}`,type:'payment_intent.succeeded',request:{id:`req_${f.accepted.body.attemptId}`,idempotency_key:`capture:${f.accepted.body.attemptId}`},
      data:{object:{...f.capture.object,amount_received:9999}}};
    await f.receive(event);await refused(f);
  });
  it('an additional authorization result cannot borrow the original P-B disposition',async()=>{
    const f=await h.fixture();await(await f.exchange()).publish();await refused(f);
  });
  it('a genuinely configured unrelated account/scope is not mistaken for this capture',async()=>{
    const f=await h.fixture(),other=await h.fixture({currency:'EUR'});
    await refused(f,{...await h.captureRevisions(f),intent:other.intentId});
    await h.inspectPlan(f);await h.inspectPlan(other);
  });
  it.each(['payment','attempt','journal','application','disposition','revision','effect-link','audit','inbox'] as const)
   ('a valid preparation still immediately refuses the %s financial/finality write',async kind=>{
      const f=await h.fixture(),r=await h.captureRevisions(f),before=await h.captureState(f);
      const table={payment:'payments',attempt:'payment_attempts',journal:'ledger_transactions',application:'financial_applications',
        disposition:'financial_application_dispositions',revision:'financial_application_revision_effects','effect-link':'financial_application_effect_links',audit:'audit_logs',inbox:'webhook_events'}[kind];
      // Give this disposable adversarial worker raw DML to exercise SQL guards, not just ACL refusal.
      await h.db.sql.unsafe(`grant insert,update,select on public.${table} to "${h.worker.role}"`);
      await expect(h.worker.sql.begin(async tx=>{
        await h.prepareCapture(tx,r);const plan=(await h.readCapture(tx))[0].plan;
        if(kind==='payment')await tx`update payments set captured_amount=10000,status='CAPTURED' where id=${f.paymentId}`;
        else if(kind==='attempt')await tx`update payment_attempts set status='SUCCEEDED' where id=${f.accepted.body.attemptId}`;
        else if(kind==='journal')await tx`insert into ledger_transactions(merchant_id,business_type,business_id,currency) values(${f.merchantId},'CAPTURE',${f.accepted.body.attemptId},${f.currency})`;
        else if(kind==='application')await tx`insert into financial_applications(root_id,manifest_id,result,audit_id) values(${plan.root_id},${plan.id},'POSTED',${h.randomUUID()})`;
        else if(kind==='disposition')await tx`insert into financial_application_dispositions(root_id,inbox_id,obligation_revision,disposition) values(${plan.root_id},${r.inbox},${r.obligation},'APPLIED')`;
        else if(kind==='revision')await tx`insert into financial_application_revision_effects(manifest_id,root_id,prior_revision,final_revision) values(${plan.id},${plan.root_id},${r.scope},${String(BigInt(r.scope)+1n)})`;
        else if(kind==='effect-link')await tx`insert into financial_application_effect_links(manifest_id,root_id,relation_name,effect_id,merchant_id,currency,payment_id,journal_id)
          values(${plan.id},${plan.root_id},'ledger_transactions',${h.randomUUID()},${f.merchantId},${f.currency},${f.paymentId},${h.randomUUID()})`;
        else if(kind==='audit')await tx`insert into audit_logs(merchant_id,actor_type,action,target_type,target_id,metadata) values(null,'SYSTEM','unrelated','payment',${h.randomUUID()},${tx.json({rootId:plan.root_id.toUpperCase()})})`;
        else await tx`update webhook_events set status='PROCESSED',processed_at=now() where id=${r.inbox}`;
      })).rejects.toThrow(/Capture .*closed before B2-B/);
      expect(await h.captureState(f)).toEqual(before);
      await h.db.sql.unsafe(`revoke insert,update,select on public.${table} from "${h.worker.role}"`);
    });
  it('a caller cannot write capture lease columns directly even after receiving raw DML for a refusal probe',async()=>{
    const f=await h.fixture(),before=await h.captureState(f);
    await h.db.sql.unsafe(`grant update,select on public.webhook_events to "${h.worker.role}"`);
    try{await expect(h.worker.sql`update webhook_events set attempts=attempts+1 where id=${f.capture.inboxId}`).rejects.toThrow(/closed before B2-B/);}
    finally{await h.db.sql.unsafe(`revoke update,select on public.webhook_events from "${h.worker.role}"`);}
    expect(await h.captureState(f)).toEqual(before);
  });
  it.each(['capture_preparation_issuances','financial_application_roots','financial_application_manifests','financial_application_permits'])
   ('the %s deferred guard independently refuses an otherwise complete preparation with zero financial groups',async relation=>{
      const f=await h.fixture(),r=await h.captureRevisions(f),before=await h.captureState(f);
      const others=['capture_preparation_issuances','financial_application_roots','financial_application_manifests','financial_application_permits'].filter(t=>t!==relation);
      // Isolate one deferred backstop; positive preparation still runs every immediate authority guard.
      for(const table of others)await h.db.sql.unsafe(`alter table public.${table} disable trigger capture_preparation_complete`);
      try{await expect(h.worker.sql.begin(tx=>h.prepareCapture(tx,r))).rejects.toThrow(/cannot commit before B2-B/);}
      finally{for(const table of others)await h.db.sql.unsafe(`alter table public.${table} enable trigger capture_preparation_complete`);}
      expect(await h.captureState(f)).toEqual(before);
    });
  it('an enrolled root-only omission cannot bypass deferred closure without a permit or issuance',async()=>{
    const f=await h.fixture(),before=await h.captureState(f);
    await h.db.sql`alter table financial_application_roots disable trigger manual_authorization_issuer`;
    try{await expect(h.db.sql`insert into financial_application_roots(family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,attempt_id)
      values('CAPTURE',${f.accepted.body.attemptId},'TERMINAL',${f.merchantId},${f.currency},'STRIPE',${f.account},'LEGACY',0,${f.capture.outbox.id},${f.paymentId},${f.accepted.body.attemptId})`)
      .rejects.toThrow(/cannot commit before B2-B/);}
    finally{await h.db.sql`alter table financial_application_roots enable trigger manual_authorization_issuer`;}
    expect(await h.captureState(f)).toEqual(before);
  });
  it('a later unknown same-command invocation remains unsupported despite the selected positive response',async()=>{
    const f=await h.fixture(),producer=new TrustedProviderObservations(h.publication,{account:f.account,mode:'TEST',apiKey:'sk_test_b2a_fixture',maxNetworkRetries:0},
      new ScriptedStripeHttp(()=>new Error('isolated unknown transport')));
    await(await producer.execute(f.capture.message)).publish();await refused(f);
  });
  it('an OPEN independent exception blocks preparation without resolving capture evidence',async()=>{
    const f=await h.fixture();await h.db.sql`insert into accounting_exceptions(merchant_id,currency,payment_id,category,source_kind,evidence_key,observed_conflict)
      values(${f.merchantId},${f.currency},${f.paymentId},'AMBIGUOUS_PROVIDER_NET_EFFECT','INTERNAL',${h.randomUUID()},'{}')`;
    await refused(f);
  });
  it('a later signed delivery barrier remains independently blocking',async()=>{
    const f=await h.fixture();await f.receive({...f.capture.event,data:{object:{...f.capture.object,amount_received:9999}}});
    expect(await h.db.sql`select 1 from receipt_delivery_barriers where provider_account=${f.account}`).not.toHaveLength(0);await refused(f);
  });
  it('accepts the last compatible product and refuses the next principal before Number multiplication',async()=>{
    const gross=Math.floor(Number.MAX_SAFE_INTEGER/300),f=await h.fixture({authorized:gross});
    expect((await h.inspectPlan(f)).source_manifest.money.fee).toBe(Number(BigInt(gross)*300n/10000n));
    await refused(await h.fixture({authorized:gross+1}));
  });
  it('a private check owner cannot mint an issuance even if accidentally granted INSERT',async()=>{
    const f=await h.fixture(),plan=await h.inspectPlan(f),[row]=await h.db.sql<{name:string}[]>`select 'fintech_capture_check_'||md5(current_database()) name`;
    await h.db.sql.unsafe(`grant insert on public.capture_preparation_issuances to "${row.name}"`);
    try{await expect(h.db.transaction(async tx=>{
      await tx.unsafe(`set local role "${row.name}"`);
      await tx`insert into capture_preparation_issuances(transaction_id,backend_pid,database_principal,intent_manifest_id,root_id,manifest_id,root_image,manifest_image)
        values(pg_current_xact_id(),pg_backend_pid(),session_user,${f.intentId},${plan.root_id},${plan.id},'{}','{}')`;
    })).rejects.toThrow(/Protected SQL capture preparation issuance/);}
    finally{await h.db.sql.unsafe(`revoke insert on public.capture_preparation_issuances from "${row.name}"`);}
  });
  it('a caller GUC cannot supply a current transaction permit',async()=>{
    await expect(h.worker.sql.begin(async tx=>{await tx`select set_config('app.financial_permit','{"approved":true}',true)`;await h.readCapture(tx);})).rejects.toThrow();
  });
  it('expired lease reclamation advances generation and fences the previous worker',async()=>{
    const f=await h.fixture(),old=await h.captureRevisions(f);
    // Clock aging is fixture-only; the real reclaim still uses the restricted claim owner and witness.
    await h.db.sql`alter table webhook_events disable trigger capture_preparation_write`;
    try{await h.db.sql`update webhook_events set locked_at=now()-interval '3 minutes' where id=${f.capture.inboxId}`;}
    finally{await h.db.sql`alter table webhook_events enable trigger capture_preparation_write`;}
    const generation=Number((await h.peer`select public.claim_capture_preparation(${f.capture.inboxId}) n`)[0].n);expect(generation).toBe(2);
    await refused(f,old);await h.inspectPlan({...f,generation});
  });
  it.each([false,true])('B1 account UPDATE versus preparation SHARE has the approved wait (binder first=%s)',async binderFirst=>{
    const f=await h.fixture(),equivalent=await h.captureEvidence(f,f.accepted),request=await h.captureRevisions(f),rollback=new Error('intentional preparation rollback');
    let release!:()=>void,ready!:()=>void,waiting!:()=>void,holder=0,waiter=0;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;}),queued=new Promise<void>(r=>{waiting=r;});
    const bind=(tx:TransactionSql)=>tx`select public.bind_payment_operation_obligation(${equivalent.inboxId},${equivalent.proofId},1)`;
    const first=(binderFirst?h.receipt.correlator:h.worker.sql).begin(async tx=>{
      holder=Number((await tx`select pg_backend_pid() p`)[0].p);if(binderFirst)await bind(tx);else await h.prepareCapture(tx,request);ready();await gate;if(!binderFirst)throw rollback;
    }).catch(e=>{if(e!==rollback)throw e;});let second:Promise<unknown>|undefined;
    try{await Promise.race([started,first]);second=(binderFirst?h.peer:h.receipt.correlationPeer).begin(async tx=>{
      waiter=Number((await tx`select pg_backend_pid() p`)[0].p);waiting();if(binderFirst){await h.prepareCapture(tx,request);throw rollback;}else await bind(tx);
    }).catch(e=>{if(e!==rollback)throw e;});await queued;await waitFor(holder,waiter);release();await Promise.all([first,second]);}
    finally{release();await Promise.allSettled([first,...(second?[second]:[])]);}
    expect(await h.captureState(f)).toMatchObject({roots:1,preparations:0,journals:0,lots:0});
  });
  it('payment NO KEY UPDATE waits behind the legacy attempt/FK edge without blocking KEY SHARE',async()=>{
    const f=await h.fixture(),request=await h.captureRevisions(f),rollback=new Error('intentional preparation rollback');
    let release!:()=>void,ready!:()=>void,holder=0,waiter=0;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});
    const first=h.db.transaction(async tx=>{holder=Number((await tx`select pg_backend_pid() p`)[0].p);await tx`select 1 from payment_attempts where id=${f.accepted.body.attemptId} for update`;ready();await gate;
      await tx`select 1 from payments where id=${f.paymentId} for key share`;});let second:Promise<unknown>|undefined;
    try{await Promise.race([started,first]);second=h.peer.begin(async tx=>{waiter=Number((await tx`select pg_backend_pid() p`)[0].p);await h.prepareCapture(tx,request);throw rollback;}).catch(e=>{if(e!==rollback)throw e;});
      for(let n=0;n<150&&waiter===0;n++)await delay(20);await waitFor(holder,waiter);release();await Promise.all([first,second]);}
    finally{release();await Promise.allSettled([first,...(second?[second]:[])]);}
    expect(await h.captureState(f)).toMatchObject({roots:1,preparations:0,journals:0,lots:0});
  });
  async function twoPreparations(sameInbox:boolean){
    const f=await h.fixture();let peerFixture=f;
    if(!sameInbox){const equivalent=await h.captureEvidence(f,f.accepted);const generation=Number((await h.peer`select public.claim_capture_preparation(${equivalent.inboxId}) n`)[0].n);peerFixture={...f,capture:equivalent,generation};}
    const one=await h.captureRevisions(f),two=await h.captureRevisions(peerFixture),rollback=new Error('rollback');
    let release!:()=>void,ready!:()=>void,waiting!:()=>void,holder=0,waiter=0;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;}),queued=new Promise<void>(r=>{waiting=r;});
    const run=async(tx:TransactionSql,r:CapturePreparationRequest)=>{await h.prepareCapture(tx,r);expect((await h.readCapture(tx))[0].plan.source_manifest.executable).toBe(false);};
    const first=h.worker.sql.begin(async tx=>{holder=Number((await tx`select pg_backend_pid() p`)[0].p);await run(tx,one);ready();await gate;throw rollback;}).catch(e=>{if(e!==rollback)throw e;});
    let second:Promise<unknown>|undefined;
    try{await Promise.race([started,first]);second=h.peer.begin(async tx=>{waiter=Number((await tx`select pg_backend_pid() p`)[0].p);waiting();await run(tx,two);throw rollback;}).catch(e=>{if(e!==rollback)throw e;});
      await queued;await waitFor(holder,waiter);release();await Promise.all([first,second]);
    }finally{release();await Promise.allSettled([first,...(second?[second]:[])]);}
    expect(await h.captureState(f)).toMatchObject({roots:1,preparations:0,journals:0,lots:0});
  }
  it('serializes same-inbox preparation before account locks',()=>twoPreparations(true));
  it('serializes equivalent distinct inboxes at the shared scope without a circular inbox wait',()=>twoPreparations(false));
});
