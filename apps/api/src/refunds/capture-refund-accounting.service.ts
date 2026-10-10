import { randomUUID } from 'node:crypto';
import type { AuthActor } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import { IdempotencyService } from '../common/idempotency.service';
import { DatabaseService, type DbTransaction } from '../database/database.service';
import { allocateRefundFifo, captureRefundFeeDelta, type FrozenRefundAllocation } from '../ledger/capture-allocation';
import { LedgerService } from '../ledger/ledger.service';
import type { LedgerAccountCode, LedgerLine } from '../ledger/ledger.types';
import { OutboxService } from '../outbox/outbox.service';
import type { PaymentStatus } from '../payments/payment-state.machine';
import type { ProviderEvent } from '../webhooks/webhook.types';
import type { CreateRefundDto } from './refunds.dto';

interface Payment { id:string; merchant_id:string; currency:string; status:PaymentStatus; captured_amount:string; refunded_amount:string }
interface Lot {
  id:string; capture_attempt_id:string; provider_reference:string|null; original_gross:string; original_fee:string;
  financial_micros:string; settlement_state:string; verified:boolean;
  refunded:string; returned_fee:string; reserved:string; disputed:string; lost:string; held:string;
}
interface Allocation { id:string; capture_lot_id:string; reserved_gross:string; status:string; confirmed_fee:string|null; journal_id:string|null }
interface Refund { id:string; payment_id:string; merchant_id:string; currency:string; amount:string; status:string; provider_transaction_id:string|null }
type ProviderMirror = {
  id:string; provider:string; operation:string; refund_id:string; provider_idempotency_key:string;
  provider_transaction_id:string; payment_id:string; merchant_id:string; currency:string; amount:string; payment_intent_id:string|null;
};
type ProviderIdentityEvidence = {
  eventPaymentIntentId:string|null; mirrors:ProviderMirror[];
  captures:{allocationId:string;captureLotId:string;captureAttemptId:string|null;paymentIntentId:string|null}[];
};
type Disposition = 'PROCESSED'|'ACCOUNTING_EXCEPTION';

// Deliberately absent from RefundsModule/controllers/WebhookBusinessService.
// The production gate requires ACTIVE, which the current schema cannot create.
// Only an isolated PostgreSQL test subclass admits synthetic dormant fixtures.
export class CaptureRefundAccountingService {
  constructor(private readonly database:DatabaseService,private readonly idempotency:IdempotencyService,
    private readonly outbox:OutboxService,private readonly audit:AuditService,private readonly ledger:LedgerService) {}

  protected assertActiveScope(status:string):void {
    if (status!=='ACTIVE') throw new DomainError('ACCOUNTING_SCOPE_INACTIVE','Capture-level refund accounting is not activated',409);
  }

  create(actor:AuthActor,paymentId:string,key:string,dto:CreateRefundDto) {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED','A merchant context is required',403);
    const merchantId=actor.merchantId;
    this.exactAmount(dto.amount);
    return this.idempotency.execute({merchantId,operation:`refund.create:${paymentId}`,key,payload:dto,responseStatus:202,action:async (tx) => {
      const payment=await this.lockPaymentScope(tx,paymentId,merchantId);
      if (!['CAPTURED','PARTIALLY_REFUNDED'].includes(payment.status)) throw new DomainError('PAYMENT_NOT_REFUNDABLE','Payment is not refundable',409);
      const lots=await this.lockLots(tx,payment);
      const conflict=await this.historyConflict(tx,payment,lots);
      if (conflict) throw new DomainError('ACCOUNTING_REVIEW_REQUIRED',conflict,409);
      const refundId=randomUUID();
      let assignments:FrozenRefundAllocation[];
      try {
        assignments=allocateRefundFifo({merchantId,paymentId,currency:payment.currency,refundId,gross:BigInt(dto.amount),lots:lots.map((l) => ({
          id:l.id,captureAttemptId:l.capture_attempt_id,merchantId,paymentId,currency:payment.currency,financialCapturedAtMicros:BigInt(l.financial_micros),
          originalGross:BigInt(l.original_gross),originalFee:BigInt(l.original_fee),confirmedRefundGross:BigInt(l.refunded),reservedRefundGross:BigInt(l.reserved),
          activeDisputeGross:BigInt(l.disputed),lostDisputeGross:BigInt(l.lost),
        }))});
      } catch (error) { throw new DomainError('REFUND_CAPACITY_UNAVAILABLE',error instanceof Error?error.message:'Invalid allocation capacity',422); }
      const references=new Set(assignments.map((a) => lots.find((l) => l.id===a.lotId)!.provider_reference));
      if (references.size!==1 || ![...references][0]?.startsWith('pi_')) throw new DomainError('INCOMPATIBLE_CAPTURE_PROVIDER_REFERENCES','Allocated captures require one known PaymentIntent reference',409);
      const providerPaymentId=[...references][0]!;
      await tx`insert into public.refunds (id,merchant_id,payment_id,amount,currency,reason)
        values (${refundId},${merchantId},${paymentId},${dto.amount},${payment.currency},${dto.reason??null})`;
      for (const a of assignments) await tx`insert into public.refund_capture_allocations (refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross)
        values (${refundId},${a.lotId},${paymentId},${merchantId},${payment.currency},${a.gross.toString()})`;
      await this.outbox.add(tx,{aggregateType:'REFUND',aggregateId:refundId,eventType:'provider.refund.requested',payload:{
        merchantId,paymentId,refundId,amount:dto.amount,currency:payment.currency,providerPaymentId,idempotencyKey:`refund:${refundId}`,
      }});
      await this.audit.append(tx,{merchantId,actor,action:'refund.requested',targetType:'payment',targetId:paymentId,metadata:{refundId,amount:dto.amount,accountingPolicy:'CAPTURE_FIFO_V1'}});
      return {id:refundId,paymentId,status:'PENDING',amount:dto.amount,currency:payment.currency};
    }});
  }

  applySucceeded(tx:DbTransaction,inboxId:string):Promise<Disposition> { return this.applyEvidence(tx,inboxId,'refund.succeeded'); }
  applyFailed(tx:DbTransaction,inboxId:string):Promise<Disposition> { return this.applyEvidence(tx,inboxId,'refund.failed'); }

  private async applyEvidence(tx:DbTransaction,inboxId:string,type:'refund.succeeded'|'refund.failed'):Promise<Disposition> {
    const [inbox]=await tx<{payload:ProviderEvent}[]>`select payload from public.webhook_events where id=${inboxId} and provider='STRIPE' for update`;
    const data=inbox?.payload.data;
    if (!data?.refundId || !data.paymentId || !data.merchantId || inbox.payload.type!==type) throw new DomainError('INVALID_REFUND_EVIDENCE','Confirmed correlated refund evidence is required',409);
    this.exactAmount(data.amount);
    const payment=await this.lockPaymentScope(tx,data.paymentId,data.merchantId);
    const lots=await this.lockLots(tx,payment);
    const [refund]=await tx<Refund[]>`select id,payment_id,merchant_id,currency,amount::text,status,provider_transaction_id from public.refunds where id=${data.refundId}`;
    if (!refund || refund.payment_id!==payment.id || refund.merchant_id!==payment.merchant_id) throw new DomainError('PROVIDER_REFUND_MISMATCH','Provider evidence does not match refund ownership',409);
    const allocations=await tx<Allocation[]>`select id,capture_lot_id,reserved_gross::text,status,confirmed_fee::text,journal_id
      from public.refund_capture_allocations where refund_id=${refund.id} order by capture_lot_id for update`;
    const exception=(reason:string,identity?:ProviderIdentityEvidence) => this.recordException(tx,inboxId,payment,refund,allocations,reason,data.providerTransactionId,identity);
    if (refund.currency!==data.currency || payment.currency!==data.currency || BigInt(refund.amount)!==BigInt(data.amount)) return exception('Confirmed refund amount or currency contradicts accepted intent');
    if (!data.providerTransactionId || (refund.provider_transaction_id && refund.provider_transaction_id!==data.providerTransactionId)) return exception('Contradictory provider refund reference');
    // Only the mirror of this accepted refund command is identity evidence.
    // Read without a new lock; future dispatch must acquire admission before mirror writes.
    const mirrors=await tx<ProviderMirror[]>`select id,provider,operation,refund_id,provider_idempotency_key,
      provider_transaction_id,payment_id,merchant_id,currency,amount::text,payment_intent_id from public.provider_transactions
      where provider='STRIPE' and operation='REFUND' and refund_id=${refund.id} and provider_idempotency_key=${`refund:${refund.id}`}`;
    const identity:ProviderIdentityEvidence={eventPaymentIntentId:data.paymentIntentId??null,mirrors,captures:allocations.map(a=>{
      const lot=lots.find(l=>l.id===a.capture_lot_id);
      return {allocationId:a.id,captureLotId:a.capture_lot_id,captureAttemptId:lot?.capture_attempt_id??null,paymentIntentId:lot?.provider_reference??null};
    })};
    if (mirrors.some(m => m.provider_transaction_id!==data.providerTransactionId || m.payment_id!==payment.id || m.merchant_id!==payment.merchant_id
      || m.currency!==payment.currency || m.amount!==refund.amount)) return exception('Provider mirror and confirmed refund evidence disagree',identity);
    if (!allocations.length || allocations.reduce((sum,a) => sum+BigInt(a.reserved_gross),0n)!==BigInt(refund.amount)) return exception('Accepted refund lacks trustworthy frozen attribution');
    const references=new Set(identity.captures.map(c=>c.paymentIntentId));
    const frozenReference=[...references][0];
    if (references.size!==1 || !frozenReference?.startsWith('pi_')) return exception('Frozen capture provider identity requires reconciliation',identity);
    if (data.paymentIntentId && data.paymentIntentId!==frozenReference) return exception('Provider PaymentIntent disagrees with frozen capture attribution',identity);
    if (mirrors.some(m=>m.payment_intent_id && m.payment_intent_id!==frozenReference)) return exception('Provider mirror PaymentIntent disagrees with frozen capture attribution',identity);
    if (!data.paymentIntentId && !mirrors.some(m=>m.payment_intent_id===frozenReference)) return exception('Provider PaymentIntent relationship is unresolved',identity);
    if (refund.status==='SUCCEEDED') {
      if (type!=='refund.succeeded') return exception('Confirmed failure contradicts successful immutable refund');
      if (allocations.some((a) => a.status!=='CONFIRMED' || !a.journal_id)) return exception('Successful refund lacks finalized allocation evidence');
      return this.dispose(tx,inboxId);
    }
    if (refund.status==='FAILED') {
      if (type!=='refund.failed' || allocations.some((a) => a.status!=='RELEASED')) return exception('Success or inconsistent evidence follows released refund capacity');
      return this.dispose(tx,inboxId);
    }
    if (allocations.some((a) => a.status!=='RESERVED')) return exception('Refund reservation lifecycle is inconsistent');
    const [existing]=await tx`select id from public.ledger_transactions where business_type='REFUND' and business_id=${refund.id}`;
    if (existing) return exception('Unfinalized refund already has financial journal evidence');
    if (type==='refund.failed') {
      await tx`update public.refund_capture_allocations set status='RELEASED',provider_event_id=${inboxId},release_reason='CONFIRMED_PROVIDER_FAILURE' where refund_id=${refund.id}`;
      await tx`update public.refunds set status='FAILED',provider_transaction_id=${data.providerTransactionId},failure_code='PROVIDER_FAILED',updated_at=now() where id=${refund.id}`;
      await this.audit.append(tx,{merchantId:payment.merchant_id,actor:{type:'PROVIDER',id:data.providerTransactionId},action:'refund.failed',targetType:'payment',targetId:payment.id,metadata:{refundId:refund.id,accountingPolicy:'CAPTURE_FIFO_V1'}});
      return this.dispose(tx,inboxId);
    }
    const conflict=await this.historyConflict(tx,payment,lots);
    if (conflict) return exception(conflict);
    if (!['CAPTURED','PARTIALLY_REFUNDED'].includes(payment.status)) return exception(`Confirmed refund cannot apply safely in payment state ${payment.status}`);
    const lines:LedgerLine[]=[]; const fees=new Map<string,bigint>(); let returnedFee=0n;
    const add=(code:LedgerAccountCode,amount:bigint,side:'debit'|'credit') => {
      if (amount>0n) lines.push({accountCode:code,merchantId:code.startsWith('MERCHANT_')?payment.merchant_id:null,[side]:this.ledgerAmount(amount)});
    };
    for (const a of allocations) {
      const l=lots.find((row) => row.id===a.capture_lot_id);
      if (!l) return exception('Frozen allocation no longer has verified capture ownership');
      const gross=BigInt(a.reserved_gross);
      const fee=captureRefundFeeDelta({originalGross:BigInt(l.original_gross),originalFee:BigInt(l.original_fee),previousConfirmedGross:BigInt(l.refunded),
        cumulativeConfirmedGross:BigInt(l.refunded)+gross,previousConfirmedFee:BigInt(l.returned_fee)});
      const net=gross-fee;
      const entitlement=BigInt(l.original_gross)-BigInt(l.original_fee)-(BigInt(l.refunded)-BigInt(l.returned_fee))-BigInt(l.lost);
      const held=BigInt(l.held); const after=entitlement-net;
      if (held>(after>0n?after:0n)) return exception('Refund requires dispute funding adjustments not integrated in B2.2');
      const ownPending=entitlement-held>0n?entitlement-held:0n;
      const pending=l.settlement_state==='FINALIZED'?0n:(ownPending<net?ownPending:net);
      add('MERCHANT_PENDING',pending,'debit'); add('MERCHANT_AVAILABLE',net-pending,'debit'); add('PLATFORM_FEE_REFUNDS',fee,'debit');
      add(l.settlement_state==='FINALIZED'?'PLATFORM_CASH':'PSP_CLEARING',gross,'credit');
      fees.set(a.id,fee); returnedFee+=fee;
    }
    // Keep the existing Number ledger/API boundary explicit; arithmetic above is exact.
    this.ledgerAmount(BigInt(refund.amount));
    const journal=await this.ledger.post(tx,{merchantId:payment.merchant_id,businessType:'REFUND',businessId:refund.id,currency:payment.currency,description:`Refund ${refund.id}`,lines});
    for (const a of allocations) await tx`update public.refund_capture_allocations set status='CONFIRMED',confirmed_gross=reserved_gross,
      confirmed_fee=${fees.get(a.id)!.toString()},journal_id=${journal},provider_event_id=${inboxId} where id=${a.id}`;
    const refunded=BigInt(payment.refunded_amount)+BigInt(refund.amount);
    if (refunded>BigInt(payment.captured_amount)) throw new DomainError('INVALID_REFUND_TOTAL','Refund exceeds captured principal',409);
    const status=refunded===BigInt(payment.captured_amount)?'REFUNDED':'PARTIALLY_REFUNDED';
    await tx`update public.refunds set status='SUCCEEDED',platform_fee_amount=${returnedFee.toString()},provider_transaction_id=${data.providerTransactionId},updated_at=now() where id=${refund.id}`;
    await tx`update public.payments set status=${status},refunded_amount=${refunded.toString()},version=version+1,updated_at=now() where id=${payment.id}`;
    await this.audit.append(tx,{merchantId:payment.merchant_id,actor:{type:'PROVIDER',id:data.providerTransactionId},action:'refund.succeeded',targetType:'payment',targetId:payment.id,
      metadata:{refundId:refund.id,amount:refund.amount,feeDelta:returnedFee.toString(),accountingPolicy:'CAPTURE_FIFO_V1'}});
    return this.dispose(tx,inboxId);
  }

  private async lockPaymentScope(tx:DbTransaction,paymentId:string,merchantId:string):Promise<Payment> {
    const [identity]=await tx<{merchant_id:string;currency:string}[]>`select merchant_id::text,currency from public.payments where id=${paymentId} and merchant_id=${merchantId}`;
    if (!identity) throw new DomainError('PAYMENT_NOT_FOUND','Payment was not found',404);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${identity.merchant_id}:${identity.currency}`},0))`;
    const [scope]=await tx<{status:string}[]>`select status from public.capture_accounting_scopes where merchant_id=${identity.merchant_id} and currency=${identity.currency} for update`;
    this.assertActiveScope(scope?.status??'MISSING');
    const [payment]=await tx<Payment[]>`select id,merchant_id,currency,status,captured_amount::text,refunded_amount::text
      from public.payments where id=${paymentId} and merchant_id=${merchantId} for no key update`;
    if (!payment || payment.currency!==identity.currency) throw new DomainError('PAYMENT_SCOPE_CHANGED','Payment identity changed',409);
    return payment;
  }

  private async lockLots(tx:DbTransaction,p:Payment):Promise<Lot[]> {
    // Prelock every identity parent before B1 allocation triggers revisit it.
    await tx`select id from public.payment_attempts where payment_id=${p.id} and kind='CAPTURE' order by id for update`;
    await tx`select id from public.refunds where payment_id=${p.id} order by id for update`;
    await tx`select id from public.disputes where payment_id=${p.id} order by id for update`;
    await tx`select id from public.capture_accounting_lots where payment_id=${p.id} order by capture_attempt_id for update`;
    return tx<Lot[]>`select l.id,l.capture_attempt_id,a.provider_transaction_id as provider_reference,l.original_gross::text,l.original_fee::text,
      (extract(epoch from l.financial_captured_at)*1000000)::bigint::text as financial_micros,l.settlement_state,
      (l.origin='NEW_CAPTURE' and l.eligible_at is not null and v.original_valid and v.journal_id=l.capture_journal_id
        and l.merchant_id=${p.merchant_id} and l.currency=${p.currency}) as verified,
      coalesce(r.refunded,0)::text as refunded,coalesce(r.fee,0)::text as returned_fee,coalesce(r.reserved,0)::text as reserved,
      coalesce(d.disputed,0)::text as disputed,coalesce(d.lost,0)::text as lost,coalesce(d.held,0)::text as held
      from public.capture_accounting_lots l join public.payment_attempts a on a.id=l.capture_attempt_id
      join public.capture_accounting_legacy_inventory v on v.capture_attempt_id=l.capture_attempt_id
      left join lateral (select sum(confirmed_gross) filter(where status='CONFIRMED') as refunded,sum(confirmed_fee) filter(where status='CONFIRMED') as fee,
        sum(reserved_gross) filter(where status='RESERVED') as reserved from public.refund_capture_allocations where capture_lot_id=l.id) r on true
      left join lateral (select sum(gross_principal) filter(where status in ('PLANNED','OPEN')) as disputed,
        sum(gross_principal) filter(where status='CLOSED' and outcome='MERCHANT_LOST') as lost,
        sum(funded_hold+coalesce(e.delta,0)) filter(where status in ('PLANNED','OPEN')) as held
        from public.dispute_capture_allocations d left join lateral (select sum(hold_delta) as delta from public.dispute_hold_effects where allocation_id=d.id) e on true
        where capture_lot_id=l.id) d on true where l.payment_id=${p.id} order by l.financial_captured_at,l.capture_attempt_id`;
  }

  private async historyConflict(tx:DbTransaction,p:Payment,lots:Lot[]):Promise<string|null> {
    if (!lots.length || lots.some((l) => !l.verified) || lots.reduce((sum,l) => sum+BigInt(l.original_gross),0n)!==BigInt(p.captured_amount)
      || lots.reduce((sum,l) => sum+BigInt(l.refunded),0n)!==BigInt(p.refunded_amount)) return 'Capture ownership or historical refund totals require reconciliation';
    const [history]=await tx<{blocked:boolean}[]>`select
      exists(select 1 from public.accounting_exceptions where merchant_id=${p.merchant_id} and currency=${p.currency} and status='OPEN')
      or exists(select 1 from public.refunds r where payment_id=${p.id} and status in ('PENDING','PROCESSING','SUCCEEDED')
        and (select coalesce(sum(reserved_gross) filter(where status<>'RELEASED'),0) from public.refund_capture_allocations where refund_id=r.id)<>r.amount)
      or exists(select 1 from public.disputes d where payment_id=${p.id} and
        (select coalesce(sum(gross_principal),0) from public.dispute_capture_allocations where dispute_id=d.id)<>d.amount)
      or exists(select 1 from public.settlement_items where payment_id=${p.id} and capture_lot_id is null) as blocked`;
    return history.blocked?'Blocking exception or unallocated legacy financial history requires review':null;
  }

  private async recordException(tx:DbTransaction,inboxId:string,p:Payment,r:Refund,allocations:Allocation[],reason:string,providerReference:string,identity?:ProviderIdentityEvidence):Promise<Disposition> {
    const disputes=await tx<{id:string;provider_dispute_id:string}[]>`select id,provider_dispute_id from public.disputes where payment_id=${p.id} order by id`;
    const [created]=await tx<{id:string}[]>`insert into public.accounting_exceptions (merchant_id,currency,payment_id,category,source_kind,evidence_key,provider_event_id,refund_id,dispute_id,observed_conflict)
      values (${p.merchant_id},${p.currency},${p.id},'AMBIGUOUS_PROVIDER_NET_EFFECT','WEBHOOK',${`webhook:${inboxId}`},${inboxId},${r.id},${disputes[0]?.id??null},
        ${tx.json({reason,providerReference,refundStatus:r.status,amount:r.amount,disputes,...(identity?{providerIdentity:identity}:{})})}) on conflict do nothing returning id`;
    const [existing]=created?[created]:await tx<{id:string}[]>`select id from public.accounting_exceptions where merchant_id=${p.merchant_id}
      and currency=${p.currency} and category='AMBIGUOUS_PROVIDER_NET_EFFECT' and evidence_key=${`webhook:${inboxId}`}`;
    for (const a of allocations) await tx`insert into public.accounting_exception_lots (exception_id,capture_lot_id,payment_id,merchant_id,currency)
      values (${existing.id},${a.capture_lot_id},${p.id},${p.merchant_id},${p.currency}) on conflict do nothing`;
    await tx`update public.webhook_events set status='ACCOUNTING_EXCEPTION',processed_at=null,locked_at=null,last_error=${reason},updated_at=now() where id=${inboxId}`;
    return 'ACCOUNTING_EXCEPTION';
  }

  private async dispose(tx:DbTransaction,inboxId:string):Promise<Disposition> {
    await tx`update public.webhook_events set status='PROCESSED',processed_at=coalesce(processed_at,now()),locked_at=null,updated_at=now() where id=${inboxId}`;
    return 'PROCESSED';
  }
  private exactAmount(amount:number):void {
    if (!Number.isSafeInteger(amount) || amount<=0) throw new DomainError('INVALID_REFUND_AMOUNT','Refund amount must be a positive safe integer',422);
  }
  private ledgerAmount(amount:bigint):number {
    if (amount<0n || amount>BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError('LEDGER_AMOUNT_UNREPRESENTABLE','Exact refund effect exceeds the existing ledger Number boundary',409);
    return Number(amount);
  }
}
