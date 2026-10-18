import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { DatabaseService, DbTransaction } from '../../src/database/database.service';
import { normalizeStripeEvent } from '../../src/webhooks/stripe-event.normalizer';
import { captureFixture } from './accounting-fixtures';

export type EvidenceFixture = Awaited<ReturnType<typeof trustedEvidenceFixture>>;
export async function trustedEvidenceFixture(database:DatabaseService,account=`acct_isolated_${randomUUID()}`) {
  const f=await captureFixture(database); const pi=`pi_${f.paymentId}`,charge=`ch_${f.attemptId}`,refundId=randomUUID();
  await database.sql`insert into financial_evidence_accounts (provider,provider_account) values ('STRIPE',${account}) on conflict do nothing`;
  await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD') on conflict do nothing`;
  const [lot]=await database.sql<{id:string}[]>`insert into capture_accounting_lots
    (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at)
    select ${f.attemptId},${f.paymentId},${f.merchantId},'USD',id,10000,300,9700,posted_at,posted_at from ledger_transactions where id=${f.journalId} returning id`;
  await database.sql`insert into refunds (id,merchant_id,payment_id,amount,currency) values (${refundId},${f.merchantId},${f.paymentId},5000,'USD')`;
  await database.sql`insert into refund_capture_allocations (refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross)
    values (${refundId},${lot.id},${f.paymentId},${f.merchantId},'USD',5000)`;
  const capturePayload={merchantId:f.merchantId,paymentId:f.paymentId,attemptId:f.attemptId,amount:10000,currency:'USD',providerPaymentId:pi,idempotencyKey:`capture:${f.attemptId}`};
  const refundPayload={merchantId:f.merchantId,paymentId:f.paymentId,refundId,amount:5000,currency:'USD',providerPaymentId:pi,idempotencyKey:`refund:${refundId}`};
  const [captureCommand]=await database.sql<{id:string}[]>`insert into outbox_events (aggregate_type,aggregate_id,event_type,payload)
    values ('PAYMENT_ATTEMPT',${f.attemptId},'provider.capture.requested',${database.sql.json(capturePayload)}) returning id`;
  const [refundCommand]=await database.sql<{id:string}[]>`insert into outbox_events (aggregate_type,aggregate_id,event_type,payload)
    values ('REFUND',${refundId},'provider.refund.requested',${database.sql.json(refundPayload)}) returning id`;
  return {...f,account,pi,charge,lotId:lot.id,refundId,objectId:`re_${refundId}`,captureCommandId:captureCommand.id,refundCommandId:refundCommand.id,capturePayload,refundPayload};
}

// These fixture publishers are deliberately separate from the real receiver and
// consumer. The tests grant them only on a disposable local database.
export async function publishCommandObservation(tx:DbTransaction,f:EvidenceFixture,kind:'CAPTURE'|'REFUND',objectId?:string) {
  const [row]=await tx<{id:string}[]>`insert into provider_financial_observations
    (provider,provider_account,source_kind,source_key,object_kind,provider_object_id,payment_id,merchant_id,currency,amount,
      outbox_id,command_key,command_payload,refund_id,capture_attempt_id,payment_intent_id,charge_id,provider_status,snapshot,observed_at,publisher_version)
    values ('STRIPE',${f.account},'COMMAND_RESULT',${`isolated-result:${randomUUID()}`},${kind},${objectId??(kind==='REFUND'?f.objectId:f.pi)},${f.paymentId},${f.merchantId},'USD',${kind==='REFUND'?5000:10000},
      ${kind==='REFUND'?f.refundCommandId:f.captureCommandId},${kind==='REFUND'?`refund:${f.refundId}`:`capture:${f.attemptId}`},${tx.json(kind==='REFUND'?f.refundPayload:f.capturePayload)},
      ${kind==='REFUND'?f.refundId:null},${kind==='CAPTURE'?f.attemptId:null},${f.pi},${f.charge},'succeeded',${tx.json({isolatedFixture:true})},now(),'isolated-command-fixture/v1') returning id`;
  return row.id;
}

export function signedEvidence(f:EvidenceFixture,options:{kind?:'refund'|'dispute';status?:string;metadata?:Record<string,string>;object?:Record<string,unknown>;externalType?:string;providerAccount?:string}={}) {
  const kind=options.kind??'refund',status=options.status??(kind==='refund'?'succeeded':'needs_response');
  const event={id:`evt_${randomUUID()}`,object:'event',api_version:'2026-03-25.dahlia',created:Math.floor(Date.now()/1000),livemode:false,
    ...(options.providerAccount?{account:options.providerAccount}:{}),
    type:options.externalType??(kind==='refund'?'refund.updated':status==='won'||status==='lost'?'charge.dispute.closed':'charge.dispute.created'),
    data:{object:{id:kind==='refund'?f.objectId:`dp_${f.refundId}`,object:kind,status,amount:5000,currency:'usd',payment_intent:f.pi,charge:f.charge,
      metadata:options.metadata??{merchantId:f.merchantId,paymentId:f.paymentId,...(kind==='refund'?{refundId:f.refundId}:{})},...options.object}}};
  const stripe=new Stripe('sk_test_isolated_evidence_fixture');const raw=Buffer.from(JSON.stringify(event));
  const signature=stripe.webhooks.generateTestHeaderString({payload:raw.toString('utf8'),secret:'whsec_isolated_evidence_fixture'});
  const verified=stripe.webhooks.constructEvent(raw,signature,'whsec_isolated_evidence_fixture');
  return {event,raw,signature,payload:normalizeStripeEvent(verified)};
}

export async function storeOriginalInbox(database:DatabaseService,signed:ReturnType<typeof signedEvidence>) {
  const [row]=await database.sql<{id:string}[]>`insert into webhook_events (provider,provider_event_id,event_type,signature,payload,headers)
    values ('STRIPE',${signed.event.id},${signed.payload.type},${signed.signature},${database.sql.json(signed.payload as never)},'{}'::jsonb) returning id`;
  return row.id;
}

export async function publishVerifiedReceipt(tx:DbTransaction,f:EvidenceFixture,inboxId:string,signed:ReturnType<typeof signedEvidence>) {
  await tx`insert into provider_financial_receipts (inbox_id,provider,provider_account,raw_body,signature,headers,normalized_payload,
    normalization_version,verification_method,verification_version,received_at,verified_at)
    values (${inboxId},'STRIPE',${f.account},${signed.raw},${signed.signature},'{}'::jsonb,${tx.json(signed.payload as never)},1,'STRIPE_SDK','isolated-SDK-fixture/v1',now(),now())`;
}
