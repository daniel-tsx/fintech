import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { paymentOperationHarness, type EvidenceOptions, type PaymentEvent, type PaymentObject } from '../support/payment-operation-harness';
import { RestrictedReceiptDatabase, type ReceiptTransactions } from '../../src/webhooks/trusted-receipt-database';
import { TrustedSignedReceiptService } from '../../src/webhooks/trusted-signed-receipt.service';
import { TrustedPaymentOperationEvidence } from '../../src/webhooks/trusted-payment-operation-evidence';

const describeDb=process.env.RUN_DB_TESTS==='1'?describe:describe.skip;
describeDb('R2-B1 dormant pre-lot payment operation evidence',()=>{
  let h:Awaited<ReturnType<typeof paymentOperationHarness>>;
  beforeAll(async()=>{h=await paymentOperationHarness();},30000);
  afterAll(async()=>{if(h)await h.close();});
  type Fixture=Awaited<ReturnType<typeof h.fixture>>;
  const read=(f:Fixture)=>h.evidence.read(f.inboxId,f.operation==='CAPTURE'?'payment.capture_succeeded':f.operation==='AUTHORIZE'?'payment.authorized':'payment.cancelled');
  async function state(f:Fixture){return(await h.db.sql`select
    (select captured_amount::text from payments where id=${f.paymentId}) captured,
    (select status from payment_attempts where id=${f.accepted.id}) attempt,
    (select count(*)::int from ledger_transactions where business_id=${f.accepted.id}) journals,
    (select count(*)::int from capture_accounting_lots where payment_id=${f.paymentId}) lots,
    (select count(*)::int from financial_applications) applications,
    (select count(*)::int from financial_application_permits) permits,
    (select count(*)::int from financial_application_dispositions) dispositions,
    (select count(*)::int from payment_operation_evidence where inbox_id=${f.inboxId}) proofs`)[0];}
  async function reject(options:EvidenceOptions){const f=await h.fixture(options);expect(await f.seal()).toMatchObject({state:'BLOCKING_REVIEW'});
    expect(await state(f)).toMatchObject({captured:'0',attempt:'PENDING',journals:0,lots:0,proofs:0,applications:0,permits:0,dispositions:0});
    expect((await h.db.sql`select disposition,merchant_id,review_id from receipt_admission_obligations where inbox_id=${f.inboxId}`)[0])
      .toMatchObject({disposition:'BLOCKING_REVIEW',merchant_id:null,review_id:expect.any(String) as string});
  }
  it.each([{amount:10000,final:true},{amount:4000,final:false},{amount:4000,final:true}])('seals exact first capture %j before any financial effect',async options=>{
    const f=await h.fixture(options),s=await f.seal();expect(s.state).toBe('SEALED');const e=await read(f);
    expect(e).toMatchObject({capture_principal:String(options.amount),authorized_principal:null,source_id:f.sourceId,authorization_source_id:f.authSource,attempt_id:f.accepted.id,proof_version:1});
    expect(await state(f)).toEqual({captured:'0',attempt:'PENDING',journals:0,lots:0,applications:0,permits:0,dispositions:0,proofs:1});
    expect((await h.db.sql`select disposition,merchant_id from receipt_admission_obligations where inbox_id=${f.inboxId}`)[0]).toEqual({disposition:'AWAITING_CORRELATION',merchant_id:null});
    await expect(h.read(f)).rejects.toThrow(/blocked/);
    expect(await h.evidence.bind(f.inboxId,s.proof_id!,'0')).toMatchObject({disposition:'AWAITING_APPLICATION',merchant_id:f.merchantId,payment_operation_proof_id:s.proof_id,proof_revision:null,obligation_revision:'1'});
    expect(await read(f)).toEqual(e);await expect(h.read(f)).rejects.toThrow(/blocked/);
    expect((await h.db.sql`select disposition,reason from provider_observation_obligations where source_id=${f.sourceId}`)[0]).toEqual({disposition:'BLOCKING_REVIEW',reason:'CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED'});
  });
  it.each(['AUTHORIZE','VOID'] as const)('stores %s as workflow-only evidence without capture principal',async operation=>{
    const f=await h.fixture({operation});const s=await f.seal();expect(s.state).toBe('SEALED');
    expect(await read(f)).toMatchObject({capture_principal:null,authorized_principal:operation==='AUTHORIZE'?'10000':null,outcome:`${operation}_SUCCEEDED`});
    await h.evidence.bind(f.inboxId,s.proof_id!,'0');expect(await state(f)).toMatchObject({captured:'0',attempt:'PENDING',journals:0,lots:0,applications:0});
    expect((await h.db.sql`select count(*)::int n from outbox_events where aggregate_id in (select id from payment_attempts where payment_id=${f.paymentId})`)[0].n).toBe(operation==='AUTHORIZE'?1:2);
  });
  const eventCases:[string,(e:PaymentEvent)=>void][]=[
    ['missing received amount',e=>{delete(e.data.object as Partial<PaymentObject>).amount_received;}],
    ['cumulative snapshot without request',e=>{e.request.id=null;}],
    ['wrong original key',e=>{e.request.idempotency_key='capture:other';}],
    ['wrong causal request',e=>{e.request.id='req_other';}],
    ['wrong merchant',e=>{e.data.object.metadata.merchantId=randomUUID();}],
    ['wrong payment',e=>{e.data.object.metadata.paymentId=randomUUID();}],
    ['wrong attempt',e=>{e.data.object.metadata.captureAttemptId=randomUUID();}],
    ['wrong currency',e=>{e.data.object.currency='eur';}],
    ['wrong PI',e=>{e.data.object.id='pi_other';}],
    ['wrong charge',e=>{e.data.object.latest_charge='ch_other';}],
    ['wrong mode',e=>{e.livemode=true;e.data.object.livemode=true;}],
    ['unsupported event version',e=>{e.api_version='2020-08-27';}],
    ['contradictory principal',e=>{e.data.object.amount_received=9999;}],
    ['metadata amount without actual witness',e=>{e.data.object.amount_received=0;}],
    ['nonintegral amount',e=>{e.data.object.amount_received=100.5;}],
  ];
  it.each(eventCases)('refuses %s with a durable blocker',async(_name,event)=>reject({event}));
  it('refuses missing D02 source',async()=>reject({source:false}));
  it('refuses a partial that v1 normalization calls authorization',async()=>reject({amount:4000,final:false,event:e=>{delete e.data.object.metadata.captureAmount;delete e.data.object.metadata.captureAttemptId;}}));
  it('refuses a partial without its independent previous capturable witness',async()=>reject({amount:4000,final:false,event:e=>{delete e.data.previous_attributes;}}));
  it('refuses a cumulative second-capture amount instead of subtracting local state',async()=>reject({amount:6000,response:o=>{o.amount_received=10000;}}));
  it('refuses missing original zero-received authorization',async()=>reject({authorization:o=>{o.amount_received=4000;}}));
  it('refuses missing received principal in the genuine D02 body',async()=>reject({response:o=>{delete(o as Partial<PaymentObject>).amount_received;}}));
  it('checks every same-command returned object for contradiction',async()=>{
    const f=await h.fixture(),object=structuredClone(f.event.data.object);object.amount_received=9999;await f.publish(f.accepted,object);
    expect(await f.seal()).toMatchObject({state:'BLOCKING_REVIEW'});expect(await state(f)).toMatchObject({proofs:0,journals:0,lots:0});
  });
  it('refuses a different accepted operation even on the same owned payment',async()=>{
    const f=await h.fixture();expect(await h.evidence.seal(f.inboxId,0,'0',f.authSource,null)).toMatchObject({state:'BLOCKING_REVIEW'});
    expect(await state(f)).toMatchObject({proofs:0,journals:0,lots:0});
  });
  it('refuses a genuine source owned by another account and merchant',async()=>{
    const f=await h.fixture(),other=await h.fixture();expect(await h.evidence.seal(f.inboxId,0,'0',other.sourceId,other.authSource)).toMatchObject({state:'BLOCKING_REVIEW'});
    expect(await state(f)).toMatchObject({proofs:0});expect(await state(other)).toMatchObject({proofs:0});
  });
  it('excludes a subsequent attempt even if its reported cumulative amount happens to equal its request',async()=>{
    const f=await h.fixture({amount:4000,final:false});expect(await f.seal()).toMatchObject({state:'SEALED'});
    const next=await f.command('CAPTURE',randomUUID(),6000),object=structuredClone(f.event.data.object);
    object.amount_received=6000;object.amount_capturable=4000;Object.assign(object.metadata,{captureAttemptId:next.id,captureAmount:'6000'});
    const source=await f.publish(next,object),event=structuredClone(f.event);event.id=`evt_${randomUUID()}`;event.data.object=object;event.request={id:next.requestId,idempotency_key:next.key};
    const raw=Buffer.from(JSON.stringify(event)),receipt=await f.receiver.receive(raw,h.sign(raw).signature);
    expect(await h.evidence.seal(receipt.id,0,'0',source,f.authSource)).toMatchObject({state:'BLOCKING_REVIEW',reason:'Subsequent or unexplained recognized capture is unsupported'});
    expect(await state(f)).toMatchObject({proofs:1,journals:0,lots:0,captured:'0'});
  });
  it('refuses a malformed first-capture final flag response',async()=>reject({final:false,response:o=>{o.amount_capturable=0;}}));
  it('refuses duplicate JSON identity keys before jsonb can hide them',async()=>reject({raw:raw=>raw.replace('"amount_received":10000','"amount_received":0,"amount_received":10000')}));
  it('permits missing final-success metadata only with independent causal authority',async()=>{
    const f=await h.fixture({event:e=>{e.data.object.metadata={};}});expect(await f.seal()).toMatchObject({state:'SEALED'});expect(await read(f)).toMatchObject({capture_principal:'10000'});
  });
  it.each(['payment.capture_failed','payment.authorization_failed'])('never turns %s into positive no-effect proof',async operation=>{
    const f=await h.fixture({operation:operation==='payment.capture_failed'?'CAPTURE':'AUTHORIZE',event:e=>{e.type='payment_intent.payment_failed';e.data.object.status='requires_payment_method';}});
    expect(await f.seal()).toMatchObject({state:'BLOCKING_REVIEW'});expect(await state(f)).toMatchObject({proofs:0,journals:0,lots:0});
  });
  it('retains success proof and blocks reordered failure without changing the attempt',async()=>{
    const f=await h.fixture();const s=await f.seal();expect(s.state).toBe('SEALED');const e=await read(f);
    const fail=structuredClone(f.event);fail.id=`evt_${randomUUID()}`;fail.type='payment_intent.payment_failed';fail.data.object.status='requires_payment_method';
    const raw=Buffer.from(JSON.stringify(fail)),signed=h.sign(raw);const receipt=await f.receiver.receive(raw,signed.signature);
    expect(await h.evidence.seal(receipt.id,0,'0',f.sourceId,f.authSource)).toMatchObject({state:'BLOCKING_REVIEW'});
    await expect(read(f)).rejects.toThrow(/Reordered contradictory/);
    expect((await h.db.sql`select fingerprint from payment_operation_evidence where inbox_id=${f.inboxId}`)[0].fingerprint).toEqual(e.fingerprint);
    expect(await state(f)).toMatchObject({captured:'0',attempt:'PENDING',proofs:1,journals:0,lots:0});
  });
  it('retains earlier signed failure as a blocker when success arrives later',async()=>{
    const f=await h.fixture(),fail=structuredClone(f.event);fail.id=`evt_${randomUUID()}`;fail.type='payment_intent.payment_failed';fail.data.object.status='requires_payment_method';
    const raw=Buffer.from(JSON.stringify(fail));await f.receiver.receive(raw,h.sign(raw).signature);expect(await f.seal()).toMatchObject({state:'BLOCKING_REVIEW'});
  });
  it('seals and reads the same immutable proof on exact replay and duplicate signed delivery',async()=>{
    const f=await h.fixture();const a=await f.seal();const e=await read(f);expect(await f.seal()).toEqual(a);
    expect(await f.receiver.receive(f.raw,f.signed.signature)).toMatchObject({duplicate:true,classification:'EQUIVALENT'});expect(await read(f)).toEqual(e);
  });
  it('rechecks a late contradictory D02 result without mutating the sealed proof',async()=>{
    const f=await h.fixture();await f.seal();const before=await read(f),object=structuredClone(f.event.data.object);object.amount_received=9999;await f.publish(f.accepted,object);
    await expect(read(f)).rejects.toThrow(/Contradictory same-command/);
    expect((await h.db.sql`select fingerprint from payment_operation_evidence where inbox_id=${f.inboxId}`)[0].fingerprint).toEqual(before.fingerprint);
  });
  it('does not reinterpret immutable facts after an unrelated intake revision advances',async()=>{
    const f=await h.fixture();await f.seal();const before=await read(f),event=structuredClone(f.event);event.id=`evt_${randomUUID()}`;
    const raw=Buffer.from(JSON.stringify(event));await f.receiver.receive(raw,h.sign(raw).signature);expect(await read(f)).toEqual(before);
    expect(BigInt(String((await h.db.sql`select evidence_revision from receipt_intake_authority where provider='STRIPE' and provider_account=${f.account}`)[0].evidence_revision))).toBeGreaterThan(BigInt(String(before.intake_revision)));
  });
  it('retains independent later-delivery conflict even after payment-proof binding',async()=>{
    const f=await h.fixture();const s=await f.seal();await h.evidence.bind(f.inboxId,s.proof_id!,'0');const event=structuredClone(f.event);event.data.object.amount_received=9999;
    const raw=Buffer.from(JSON.stringify(event));expect(await f.receiver.receive(raw,h.sign(raw).signature)).toMatchObject({classification:'CONFLICT'});
    expect((await h.db.sql`select count(*)::int n from receipt_delivery_barriers where delivery_id in (select id from receipt_delivery_attempts where original_inbox_id=${f.inboxId})`)[0].n).toBe(1);
    await expect(read(f)).rejects.toThrow(/Contradictory/);
  });
  it('does not recategorize old contract1 PI admission or adopt it as payment evidence',async()=>{
    const f=await h.fixture({oldAdmission:true});expect((await h.db.sql`select contract_version,operation from receipt_admissions where inbox_id=${f.inboxId}`)[0]).toEqual({contract_version:1,operation:'provider.unclassified'});
    expect(await f.seal()).toMatchObject({state:'BLOCKING_REVIEW'});expect((await h.db.sql`select operation from receipt_admissions where inbox_id=${f.inboxId}`)[0].operation).toBe('provider.unclassified');
  });
  it('preserves contract1 pending-refund neutrality and nonfinancial classification through isolated publication',async()=>{
    const f=await h.fixture();
    for(const [type,object] of [['refund.updated',{id:`re_${randomUUID()}`,object:'refund',amount:100,currency:'usd',status:'pending',metadata:{}}],
      ['customer.created',{id:`cus_${randomUUID()}`,object:'customer'}]] as const){
      const raw=Buffer.from(JSON.stringify({id:`evt_${randomUUID()}`,object:'event',account:f.account,created:Math.floor(Date.now()/1000),type,data:{object}}));
      const receipt=await f.receiver.receive(raw,h.sign(raw).signature),[admission]=await h.db.sql`select contract_version,operation,financially_relevant from receipt_admissions where inbox_id=${receipt.id}`;
      expect(admission).toEqual(type==='refund.updated'?{contract_version:1,operation:'refund.pending',financially_relevant:true}:{contract_version:1,operation:'provider.unrelated',financially_relevant:false});
      const obligations=await h.db.sql`select disposition,review_id from receipt_admission_obligations where inbox_id=${receipt.id}`;
      expect(obligations).toEqual(type==='refund.updated'?[{disposition:'AWAITING_CONFIRMATION',review_id:null}]:[]);
    }
  });
  it.each(['update','delete','truncate'])('rejects proof %s even under migration setup authority',async op=>{
    const f=await h.fixture();await f.seal();const sql=op==='update'?`update payment_operation_evidence set facts=facts where inbox_id='${f.inboxId}'`:op==='delete'?`delete from payment_operation_evidence where inbox_id='${f.inboxId}'`:'truncate payment_operation_evidence';
    await expect(h.db.sql.unsafe(sql)).rejects.toThrow();expect(await read(f)).toMatchObject({capture_principal:'10000'});
  });
  it('rejects direct ordinary-role evidence writes and financial access',async()=>{
    const f=await h.fixture();await f.seal();const login=h.receipt.correlator;
    await expect(login`update payment_operation_evidence set facts='{}'`).rejects.toThrow(/permission denied/);
    await expect(login`insert into financial_application_contracts values('CAPTURE','TERMINAL','LEGACY',1,'public.payment_json(bytea)'::regprocedure,'public.payment_json(bytea)'::regprocedure)`).rejects.toThrow(/permission denied/);
    await expect(login`insert into ledger_transactions(business_type,business_id,currency,description) values('CAPTURE',${f.accepted.id},'USD','forged')`).rejects.toThrow(/permission denied/);
    expect(await h.db.sql`select 1 from financial_application_contracts`).toHaveLength(0);expect(await h.db.sql`select 1 from financial_application_scope_authority`).toHaveLength(0);
  });
  it('rejects owner pools and column-only evidence write capabilities',async()=>{
    await expect(new RestrictedReceiptDatabase(h.db.sql,'PAYMENT_CORRELATOR').transaction(()=>Promise.resolve(true))).rejects.toThrow(/dedicated restricted/);
    const f=await h.fixture(),role=h.receipt.roles.correlator;
    await h.db.sql.unsafe(`grant insert(facts) on payment_operation_evidence to "${role}"`);
    try{await expect(f.seal()).rejects.toThrow(/restricted function capabilities/);}finally{await h.db.sql.unsafe(`revoke insert(facts) on payment_operation_evidence from "${role}"`);}
    expect(await state(f)).toMatchObject({proofs:0});
  });
  it('atomically rolls back first receipt and contract2 enrollment when publication acknowledgment aborts',async()=>{
    const f=await h.fixture(),event=structuredClone(f.event);event.id=`evt_${randomUUID()}`;const raw=Buffer.from(JSON.stringify(event)),signed=h.sign(raw);
    const receiver=new TrustedSignedReceiptService({transaction:work=>h.receipt.publication.transaction(async tx=>{await work(tx);throw new Error('planned publication abort');})},
      {account:f.account,webhookSecret:h.receipt.secret,admissionContract:'PAYMENT_OPERATION_V2'},h.receipt.stripe);
    await expect(receiver.receive(raw,signed.signature)).rejects.toThrow('planned publication abort');expect(await h.db.sql`select id from webhook_events where provider_event_id=${event.id}`).toHaveLength(0);
    const receipt=await f.receiver.receive(raw,signed.signature);expect((await h.db.sql`select contract_version from receipt_admissions where inbox_id=${receipt.id}`)[0].contract_version).toBe(2);
  });
  it('compares expected revision and leaves failed transfer unbound',async()=>{
    const f=await h.fixture();const s=await f.seal();await expect(h.evidence.bind(f.inboxId,s.proof_id!,'1')).rejects.toThrow(/Stale/);
    expect((await h.db.sql`select disposition,payment_operation_proof_id from receipt_admission_obligations where inbox_id=${f.inboxId}`)[0]).toEqual({disposition:'AWAITING_CORRELATION',payment_operation_proof_id:null});
    await h.evidence.bind(f.inboxId,s.proof_id!,'0');await expect(f.seal()).rejects.toThrow(/Stale/);expect(await f.seal('1')).toMatchObject({proof_id:s.proof_id});
    const before=await read(f);await h.db.sql`update merchants set fee_bps=999 where id=${f.merchantId}`;expect(await read(f)).toEqual(before);
  });
  it('rolls back proof insertion and binding before safe same-source retries',async()=>{
    const f=await h.fixture();await expect(h.receipt.correlator.begin(async tx=>{await tx`select public.seal_payment_operation_evidence(${f.inboxId},0,0,${f.sourceId},${f.authSource})`;throw new Error('planned abort');})).rejects.toThrow('planned abort');
    expect(await state(f)).toMatchObject({proofs:0});const s=await f.seal();
    await expect(h.receipt.correlator.begin(async tx=>{await tx`select public.bind_payment_operation_obligation(${f.inboxId},${s.proof_id!},0)`;throw new Error('planned bind abort');})).rejects.toThrow('planned bind abort');
    expect((await h.db.sql`select obligation_revision,merchant_id from receipt_admission_obligations where inbox_id=${f.inboxId}`)[0]).toEqual({obligation_revision:'0',merchant_id:null});
    await h.evidence.bind(f.inboxId,s.proof_id!,'0');expect(await state(f)).toMatchObject({proofs:1,journals:0,lots:0});
  });
  it('observes concurrent sealer row wait and commits a single proof',async()=>{
    const f=await h.fixture();let release!:()=>void,ready!:()=>void,holder=0,waiter=0;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});
    const first=h.receipt.correlator.begin(async tx=>{holder=Number((await tx`select pg_backend_pid() p`)[0].p);const [s]=await tx`select public.seal_payment_operation_evidence(${f.inboxId},0,0,${f.sourceId},${f.authSource}) s`;ready();await gate;return s.s as unknown;});
    let second:Promise<unknown>|undefined;
    try{await Promise.race([started,first]);second=h.receipt.correlationPeer.begin(async tx=>{waiter=Number((await tx`select pg_backend_pid() p`)[0].p);return tx`select public.seal_payment_operation_evidence(${f.inboxId},0,0,${f.sourceId},${f.authSource}) s`;});
      let observed=false;for(let n=0;n<150;n++){if(waiter&&(await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) b`)[0].b){observed=true;break;}await delay(20);}expect(observed).toBe(true);expect(waiter).not.toBe(holder);
      release();await Promise.all([first,second]);expect(await state(f)).toMatchObject({proofs:1,journals:0,lots:0});
    }finally{release();await Promise.allSettled([first,...(second?[second]:[])]);}
  },15000);
  it.each(['seal-first','delivery-before-seal','bind-first','delivery-before-bind'])('serializes retained conflicting delivery with %s',async order=>{
    const f=await h.fixture(),binding=order.includes('bind');const sealed=binding?await f.seal():null;
    let release!:()=>void,ready!:()=>void,holder=0,waiter=0;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});
    function observed(base:ReceiptTransactions,first:boolean):ReceiptTransactions{return{transaction:work=>base.transaction(async tx=>{
      const pid=Number((await tx`select pg_backend_pid() p`)[0].p);if(first)holder=pid;else waiter=pid;
      const result=await work(tx);if(first){ready();await gate;}return result;
    })};}
    const deliveryFirst=order.startsWith('delivery'),correlator=new TrustedPaymentOperationEvidence(observed(new RestrictedReceiptDatabase(h.receipt.correlator,'PAYMENT_CORRELATOR'),!deliveryFirst));
    const receiver=new TrustedSignedReceiptService(observed(new RestrictedReceiptDatabase(h.receipt.peer,'PAYMENT_PUBLISHER'),deliveryFirst),
      {account:f.account,webhookSecret:h.receipt.secret,admissionContract:'PAYMENT_OPERATION_V2'},h.receipt.stripe);
    const event=structuredClone(f.event);event.data.object.amount_received=9999;const raw=Buffer.from(JSON.stringify(event)),signature=h.sign(raw).signature;
    const correlate=()=>binding?correlator.bind(f.inboxId,sealed!.proof_id!,'0'):correlator.seal(f.inboxId,0,'0',f.sourceId,f.authSource);
    const publish=()=>receiver.receive(raw,signature);
    const first:Promise<unknown>=deliveryFirst?publish():correlate();let second:Promise<unknown>|undefined;
    try{await Promise.race([started,first]);second=deliveryFirst?correlate():publish();
      // Capture rejection immediately: bind-after-conflict must abort, not hang.
      const settled=second.then(value=>({value,error:null}),error=>({value:null,error: error as Error}));
      let waiting=false;for(let n=0;n<150;n++){if(waiter&&(await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) b`)[0].b){waiting=true;break;}await delay(20);}expect(waiting).toBe(true);
      expect(waiter).not.toBe(holder);release();await first;const result=await settled;
      if(deliveryFirst&&binding)expect(result.error?.message).toMatch(/Contradictory/);else expect(result.error).toBeNull();
      expect(await state(f)).toMatchObject({captured:'0',attempt:'PENDING',journals:0,lots:0,proofs:deliveryFirst&&!binding?0:1});
      expect((await h.db.sql`select count(*)::int n from receipt_delivery_barriers where delivery_id in (select id from receipt_delivery_attempts where original_inbox_id=${f.inboxId})`)[0].n).toBe(1);
      await expect(h.read(f)).rejects.toThrow(/blocked/);
    }finally{release();await Promise.allSettled([first,...(second?[second]:[])]);}
  },15000);
});
