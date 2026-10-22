import { randomUUID } from 'node:crypto';
import { OutboxService } from '../../src/outbox/outbox.service';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import type { ProviderCommandEnvelope } from '../../src/rabbitmq/rabbitmq.types';
import { RestrictedReceiptDatabase } from '../../src/webhooks/trusted-receipt-database';
import { TrustedSignedReceiptService } from '../../src/webhooks/trusted-signed-receipt.service';
import { TrustedPaymentOperationEvidence } from '../../src/webhooks/trusted-payment-operation-evidence';
import { providerObservationHarness, ScriptedStripeHttp } from './provider-observation-harness';

export interface PaymentObject {
  id:string; object:string; amount:number; amount_received:number; amount_capturable:number; currency:string;
  latest_charge:string; livemode:boolean; status:string; capture_method:string; metadata:Record<string,string>; cancellation_reason?:string;
}
export interface PaymentEvent {
  id:string; object:string; account:string; api_version:string; livemode:boolean; created:number; type:string;
  request:{id:string|null;idempotency_key:string|null}; data:{object:PaymentObject;previous_attributes?:{amount_capturable:number}};
}
export interface EvidenceOptions {
  amount?:number; final?:boolean; operation?:'CAPTURE'|'AUTHORIZE'|'VOID';
  event?:(e:PaymentEvent)=>void; response?:(o:PaymentObject)=>void; authorization?:(o:PaymentObject)=>void;
  source?:boolean; raw?:(raw:string)=>string; oldAdmission?:boolean;
}

export async function paymentOperationHarness(migrationsFolder?: string) {
  const h=await providerObservationHarness(migrationsFolder), r=h.receipt;
  await h.db.sql.unsafe(`grant execute on function public.publish_admitted_payment_receipt(uuid,text,bytea,text) to "${r.roles.publisher}"`);
  await h.db.sql.unsafe(`grant execute on function public.seal_payment_operation_evidence(uuid,integer,bigint,uuid,uuid),public.bind_payment_operation_obligation(uuid,uuid,bigint),public.load_effective_payment_operation_evidence(uuid,integer,text) to "${r.roles.correlator}"`);
  const publication=new RestrictedReceiptDatabase(r.publisher,'PAYMENT_PUBLISHER');
  const evidence=new TrustedPaymentOperationEvidence(new RestrictedReceiptDatabase(r.correlator,'PAYMENT_CORRELATOR'));
  async function fixture(options:EvidenceOptions={}) {
    const account=`acct_b1_${randomUUID().replaceAll('-','')}`,merchantId=randomUUID(),paymentId=randomUUID(),pi=`pi_${randomUUID().replaceAll('-','')}`,charge=`ch_${randomUUID().replaceAll('-','')}`;
    await h.db.sql`insert into financial_evidence_accounts(provider,provider_account,provider_mode) values('STRIPE',${account},'TEST')`;
    await h.db.sql`insert into merchants(id,name) values(${merchantId},'B1 isolated evidence')`;
    await h.db.sql`insert into payments(id,merchant_id,status,capture_method,currency,amount,authorized_amount,payment_method_token) values(${paymentId},${merchantId},'AUTHORIZED','MANUAL','USD',10000,10000,'pm_fixture')`;
    await h.db.sql`insert into capture_accounting_scopes(merchant_id,currency) values(${merchantId},'USD')`;
    const authorizeId=randomUUID();
    async function command(operation:'CAPTURE'|'AUTHORIZE'|'VOID',id:string,amount:number) {
      const payload={merchantId,paymentId,attemptId:id,amount,currency:'USD',paymentMethodToken:'pm_fixture',
        ...(operation!=='AUTHORIZE'?{providerPaymentId:pi}:{}),...(operation==='CAPTURE'?{finalCapture:options.final??true}:{}),idempotencyKey:`${operation.toLowerCase()}:${id}`};
      const eventType:ProviderCommandEnvelope['eventType']=operation==='AUTHORIZE'?'provider.authorization.requested':operation==='CAPTURE'?'provider.capture.requested':'provider.void.requested';
      const outboxId=await h.db.transaction(async tx=>{
        await tx`select 1 from financial_evidence_accounts where provider='STRIPE' and provider_account=${account} for share`;
        await tx`insert into payment_attempts(id,merchant_id,payment_id,kind,amount,currency) values(${id},${merchantId},${paymentId},${operation},${amount},'USD')`;
        const outboxId=await new OutboxService().add(tx,{aggregateType:'PAYMENT_ATTEMPT',aggregateId:id,eventType,payload});
        await tx`select public.accept_provider_command(${outboxId},${account},'TEST')`; return outboxId;
      });
      const message:ProviderCommandEnvelope={id:outboxId,aggregateId:id,eventType,payload,createdAt:new Date().toISOString(),correlationId:randomUUID()};
      return {id,outboxId,message,key:payload.idempotencyKey,requestId:`req_${id}`};
    }
    const auth=await command('AUTHORIZE',authorizeId,10000);
    const original:PaymentObject={id:pi,object:'payment_intent',amount:10000,amount_received:0,amount_capturable:10000,currency:'usd',latest_charge:charge,livemode:false,status:'requires_capture',capture_method:'manual',metadata:{merchantId,paymentId,authorizeAttemptId:authorizeId}};
    async function publish(c:Awaited<ReturnType<typeof command>>,object:PaymentObject) {
      const body=Buffer.from(JSON.stringify(object));
      const transport=new ScriptedStripeHttp(()=>({body,headers:{'request-id':c.requestId}}));
      const producer=new TrustedProviderObservations(h.publication,{account,mode:'TEST',apiKey:'sk_test_b1_fixture',maxNetworkRetries:0},transport);
      const [source]=await(await producer.execute(c.message)).publish(); return source.id;
    }
    const authObject=structuredClone(original); options.authorization?.(authObject);
    const authSource=await publish(auth,authObject);
    const operation=options.operation??'CAPTURE',amount=operation==='AUTHORIZE'?10000:operation==='VOID'?0:options.amount??10000;
    const accepted=operation==='AUTHORIZE'?auth:await command(operation,randomUUID(),amount);
    const object=structuredClone(original);
    if(operation==='CAPTURE') {
      object.amount_received=amount; object.amount_capturable=(options.final??true)?0:10000-amount;
      object.status=(options.final??true)?'succeeded':'requires_capture';
      Object.assign(object.metadata,{captureAttemptId:accepted.id,captureAmount:String(amount),currency:'USD'});
    } else if(operation==='VOID') { object.status='canceled';object.amount_capturable=0;object.cancellation_reason='requested_by_customer'; }
    options.response?.(object);
    const sourceId=operation==='AUTHORIZE'?authSource:options.source===false?randomUUID():await publish(accepted,object);
    const event:PaymentEvent={id:`evt_${randomUUID()}`,object:'event',account,api_version:'2026-08-26.dahlia',livemode:false,created:Math.floor(Date.now()/1000),
      type:operation==='VOID'?'payment_intent.canceled':object.status==='succeeded'?'payment_intent.succeeded':'payment_intent.amount_capturable_updated',
      request:{id:accepted.requestId,idempotency_key:accepted.key},data:{object:structuredClone(object),...(operation==='CAPTURE'&&!(options.final??true)?{previous_attributes:{amount_capturable:10000}}:{})}};
    options.event?.(event);
    const receiver=new TrustedSignedReceiptService(publication,{account,webhookSecret:r.secret,admissionContract:'PAYMENT_OPERATION_V2'},r.stripe);
    const raw=Buffer.from(options.raw?.(JSON.stringify(event))??JSON.stringify(event)),signed=h.sign(raw);
    const receipt=options.oldAdmission?await h.receiver(account).receive(raw,signed.signature):await receiver.receive(raw,signed.signature);
    return {account,merchantId,paymentId,pi,charge,authorizeId,auth,authSource,accepted,operation,amount,sourceId,event,raw,signed,receiver,inboxId:receipt.id,
      seal:(revision='0')=>evidence.seal(receipt.id,0,revision,sourceId,operation==='AUTHORIZE'?null:authSource),publish,command};
  }
  return {...h,evidence,fixture};
}
