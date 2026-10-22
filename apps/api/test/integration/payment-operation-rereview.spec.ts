import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paymentOperationHarness } from '../support/payment-operation-harness';
import { TrustedPaymentOperationEvidence } from '../../src/webhooks/trusted-payment-operation-evidence';
import { RestrictedReceiptDatabase, type ReceiptTransactions } from '../../src/webhooks/trusted-receipt-database';
import { TrustedSignedReceiptService } from '../../src/webhooks/trusted-signed-receipt.service';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { ScriptedStripeHttp } from '../support/provider-observation-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
describeDb('B1.1 independent additional review regressions', () => {
  let h: Awaited<ReturnType<typeof paymentOperationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  const evidence: unknown[] = [];
  beforeAll(async () => { h = await paymentOperationHarness(); }, 30000);
  afterAll(async () => {
    if (!h) return;
    try {
      const [summary] = await h.db.sql`select version() postgres_version,
        (select count(*)::int from capture_accounting_scopes where status='ACTIVE') active_scopes,
        (select count(*)::int from financial_application_contracts) contracts,
        (select count(*)::int from financial_application_scope_authority) enrollments,
        (select count(*)::int from financial_applications) applications,
        (select count(*)::int from financial_application_permits) permits,
        (select count(*)::int from financial_application_dispositions) dispositions,
        (select count(*)::int from ledger_transactions) journals,
        (select count(*)::int from capture_accounting_lots) lots`;
      expect(summary).toMatchObject({active_scopes:0,contracts:0,enrollments:0,applications:0,permits:0,dispositions:0,journals:0,lots:0});
      writeFileSync(resolve(__dirname,'../../../../.tmp/r2b11-rereview-committed.json'), JSON.stringify({summary,evidence}, null, 2));
    } finally { await h.close(); }
  });
  async function unrelated(f: Fixture) {
    const raw = Buffer.from(JSON.stringify({id:`evt_${randomUUID()}`,object:'event',account:f.account,
      created:Math.floor(Date.now()/1000),type:'customer.updated',request:{id:'req_unrelated',idempotency_key:'unrelated'},
      data:{object:{id:'cus_unrelated',object:'customer',metadata:{note:'informational'}}}})
      .replace('"note":"informational"','"note":"informational","note":"informational"'));
    const receipt=await f.receiver.receive(raw,h.sign(raw).signature);
    const [admission]=await h.db.sql`select a.operation,a.financially_relevant,(select count(*)::int from receipt_admission_obligations where inbox_id=${receipt.id}) obligations
      from receipt_admissions a where inbox_id=${receipt.id}`;
    expect(admission).toEqual({operation:'provider.unrelated',financially_relevant:false,obligations:0});
    return {receipt,raw,admission};
  }
  it('an unrelated nonfinancial original cannot prevent sealing', async () => {
    const f=await h.fixture(); const other=await unrelated(f); const result=await f.seal();
    evidence.push({case:'unrelated-before-seal',inbox:f.inboxId,other:other.receipt.id,admission:other.admission,result});
    expect(result.state).toBe('SEALED');
  });
  it('an unrelated nonfinancial original cannot invalidate a sealed proof', async () => {
    const f=await h.fixture(); expect((await f.seal()).state).toBe('SEALED');
    const original=await h.evidence.read(f.inboxId,'payment.capture_succeeded') as {id:string;fingerprint:Buffer}; const other=await unrelated(f);
    let result:unknown,error:unknown;
    try { result=await h.evidence.read(f.inboxId,'payment.capture_succeeded'); } catch(e) { error=(e as Error).message; }
    const [persisted]=await h.db.sql`select id,fingerprint from payment_operation_evidence where inbox_id=${f.inboxId}`;
    expect(persisted).toEqual({id:original.id,fingerprint:original.fingerprint});
    evidence.push({case:'unrelated-after-seal',inbox:f.inboxId,other:other.receipt.id,admission:other.admission,error});
    expect(error).toBeUndefined(); expect(result).toEqual(original);
  });
  it('standalone authorization accepts semantically equivalent enriched responses', async () => {
    const f=await h.fixture({operation:'AUTHORIZE'}), object=structuredClone(f.event.data.object);
    Object.assign(object,{description:'same authorization with harmless enrichment'});
    await f.publish(f.accepted,object); const result=await f.seal(); evidence.push({case:'equivalent-standalone-authorization',inbox:f.inboxId,result});
    expect(result.state).toBe('SEALED');
  });
  it.each(['before-seal','after-seal'])('cannot hide a primary signed capture-method contradiction %s', async order => {
    const f=await h.fixture({event:e=>{e.data.object.capture_method='automatic';}});
    const first=order==='after-seal'?await f.seal():null;
    if(first?.state==='SEALED')await h.evidence.bind(f.inboxId,first.proof_id!,'0');
    const event=structuredClone(f.event);event.id=`evt_${randomUUID()}`;event.data.object.capture_method='manual';
    const raw=Buffer.from(JSON.stringify(event)),other=await f.receiver.receive(raw,h.sign(raw).signature);
    const selected=first??await f.seal();
    const peer=await h.evidence.seal(other.id,0,'0',f.sourceId,f.authSource);
    let readable:unknown,error:unknown;try{readable=await h.evidence.read(f.inboxId,'payment.capture_succeeded');}catch(e){error=(e as Error).message;}
    const [witness]=await h.db.sql`select
      (select convert_from(raw_body,'UTF8')::jsonb#>>'{data,object,capture_method}' from provider_financial_receipts where inbox_id=${f.inboxId}) primary_method,
      (select convert_from(raw_body,'UTF8')::jsonb#>>'{data,object,capture_method}' from provider_financial_receipts where inbox_id=${other.id}) peer_method,
      (select normalized_outcome#>>'{actual,capture_method}' from provider_observation_sources where id=${f.sourceId}) response_method`;
    expect(witness).toEqual({primary_method:'automatic',peer_method:'manual',response_method:'manual'});
    const [obligation]=await h.db.sql`select disposition,payment_operation_proof_id from receipt_admission_obligations where inbox_id=${f.inboxId}`;
    evidence.push({case:`primary-signed-capture-method-contradiction-${order}`,inbox:f.inboxId,other:other.id,selected,peer,readable,error,obligation,witness});
    if(order==='after-seal')expect(error).toBeDefined();else expect(selected.state).toBe('BLOCKING_REVIEW');
    expect(peer.state).toBe('BLOCKING_REVIEW');
  });
  it.each(['signed-first','seal-before-signed','authorization-first','seal-before-authorization'])('serializes %s publication and sealing', async order => {
    const f=await h.fixture(); let release!:()=>void,ready!:()=>void,holder=0,waiter=0;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});
    const publishFirst=order==='signed-first'||order==='authorization-first';
    const isSigned=order.includes('signed');
    function observe(base:ReceiptTransactions,first:boolean,enabled:()=>boolean=()=>true):ReceiptTransactions {
      return {transaction:work=>base.transaction(async tx=>{
        if(!enabled())return work(tx);
        await tx`set local statement_timeout='8s'`;
        const pid=Number((await tx`select pg_backend_pid() pid`)[0].pid); if(first)holder=pid;else waiter=pid;
        const result=await work(tx); if(first){ready();await gate;} return result;
      })};
    }
    const sealer=new TrustedPaymentOperationEvidence(observe(new RestrictedReceiptDatabase(h.receipt.correlator,'PAYMENT_CORRELATOR'),!publishFirst));
    const event=structuredClone(f.event);event.id=`evt_${randomUUID()}`;event.data.object.amount_received=9999;
    const raw=Buffer.from(JSON.stringify(event));
    const receiver=new TrustedSignedReceiptService(observe(new RestrictedReceiptDatabase(h.receipt.peer,'PAYMENT_PUBLISHER'),publishFirst),
      {account:f.account,webhookSecret:h.receipt.secret,admissionContract:'PAYMENT_OPERATION_V2'},h.receipt.stripe);
    const [auth]=await h.db.sql<{actual:typeof f.event.data.object}[]>`select normalized_outcome->'actual' actual from provider_observation_sources where id=${f.authSource}`;
    auth.actual.amount_received=4000;auth.actual.amount_capturable=6000;
    let publicationPhase=false;
    const producer=new TrustedProviderObservations(observe(h.peerPublication,publishFirst,()=>publicationPhase),{account:f.account,mode:'TEST',apiKey:'sk_test_rereview',maxNetworkRetries:0},
      new ScriptedStripeHttp(()=>({body:Buffer.from(JSON.stringify(auth.actual)),headers:{'request-id':f.auth.requestId}})));
    // Preparation commits before either gated transaction; only publication races sealing.
    const pending=isSigned?null:await producer.execute(f.auth.message);
    publicationPhase=true;
    const publication=()=>isSigned?receiver.receive(raw,h.sign(raw).signature):pending!.publish();
    const seal=()=>sealer.seal(f.inboxId,0,'0',f.sourceId,f.authSource);
    const first=publishFirst?publication():seal();let second:Promise<unknown>|undefined;
    try {
      await Promise.race([started,first]);second=publishFirst?seal():publication();
      const settled=second.then(value=>({value,error:null}),error=>({value:null,error:error as Error}));
      let blocked=false;for(let n=0;n<150;n++){if(waiter&&(await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) blocked`)[0].blocked){blocked=true;break;}await delay(20);}
      expect(blocked).toBe(true);expect(waiter).not.toBe(holder);release();const firstResult=await first,secondResult=await settled;
      expect(secondResult.error).toBeNull();const sealResult=(publishFirst?secondResult.value:firstResult) as {state:string};
      expect(sealResult.state).toBe(publishFirst?'BLOCKING_REVIEW':'SEALED');
      await expect(h.evidence.read(f.inboxId,'payment.capture_succeeded')).rejects.toThrow();
      const [state]=await h.db.sql`select (select count(*)::int from payment_operation_evidence where inbox_id=${f.inboxId}) proofs,
        (select disposition from receipt_admission_obligations where inbox_id=${f.inboxId}) disposition`;
      expect(state.proofs).toBe(publishFirst?0:1);evidence.push({case:order,holder,waiter,blocked,sealResult,state});
    } finally {release();await Promise.allSettled([first,...(second?[second]:[])]);}
  },20000);
});
