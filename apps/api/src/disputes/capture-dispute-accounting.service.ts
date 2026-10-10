import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import type { DbTransaction } from '../database/database.service';
import { allocateRefundFifo } from '../ledger/capture-allocation';
import { exactLedgerAmount, reduceDisputeHolds } from '../ledger/dispute-hold-adjustment';
import { LedgerService } from '../ledger/ledger.service';
import type { LedgerLine } from '../ledger/ledger.types';
import type { PaymentStatus } from '../payments/payment-state.machine';
import { RetryableWebhookError, type ProviderEvent } from '../webhooks/webhook.types';

interface Payment { id:string; merchant_id:string; currency:string; status:PaymentStatus; captured_amount:string; refunded_amount:string }
interface Lot {
  id:string; capture_attempt_id:string; provider_reference:string|null; original_gross:string; original_fee:string;
  financial_micros:string; settlement_state:string; verified:boolean;
  refunded:string; returned_fee:string; reserved:string; disputed:string; lost:string; held:string;
}
interface Dispute { id:string; payment_id:string; merchant_id:string; currency:string; amount:string; status:string; outcome:string|null }
interface Allocation { id:string; capture_lot_id:string; gross_principal:string; funded_hold:string; held:string; status:string; outcome:string|null; open_journal_id:string|null; close_journal_id:string|null }
type Disposition = 'PROCESSED'|'ACCOUNTING_EXCEPTION';

// Intentionally unregistered: no modules, controllers or live dispatcher use it.
export class CaptureDisputeAccountingService {
  constructor(private readonly ledger:LedgerService, private readonly audit:AuditService) {}
  protected assertActiveScope(status:string):void {
    if (status!=='ACTIVE') throw new DomainError('ACCOUNTING_SCOPE_INACTIVE','Capture-level dispute accounting is not activated',409);
  }
  applyOpened(tx:DbTransaction,inboxId:string):Promise<Disposition> { return this.apply(tx,inboxId,'dispute.opened'); }
  applyClosed(tx:DbTransaction,inboxId:string):Promise<Disposition> { return this.apply(tx,inboxId,'dispute.closed'); }

  private async apply(tx:DbTransaction,inboxId:string,type:'dispute.opened'|'dispute.closed'):Promise<Disposition> {
    const [inbox]=await tx<{payload:ProviderEvent}[]>`select payload from public.webhook_events where id=${inboxId} and provider='STRIPE' for update`;
    const data=inbox?.payload.data;
    if (!data?.merchantId || !data.paymentId || inbox.payload.type!==type) throw new RetryableWebhookError('Dispute evidence requires correlated payment ownership');
    const p=await this.lockPayment(tx,data.paymentId,data.merchantId);
    const lots=await this.lockLots(tx,p);
    const [d]=await tx<Dispute[]>`select id,payment_id,merchant_id,currency,amount::text,status,outcome from public.disputes where provider_dispute_id=${data.providerDisputeId??''}`;
    const allocations=d && d.payment_id===p.id?await tx<Allocation[]>`select a.id,a.capture_lot_id,a.gross_principal::text,a.funded_hold::text,
      (a.funded_hold+coalesce(e.delta,0))::text as held,a.status,a.outcome,a.open_journal_id,a.close_journal_id
      from public.dispute_capture_allocations a left join lateral (select sum(hold_delta) as delta from public.dispute_hold_effects where allocation_id=a.id) e on true
      where dispute_id=${d.id} order by capture_lot_id`:[];
    const exception=(reason:string) => this.exception(tx,inboxId,p,lots,d,reason,data);
    if (!data.providerDisputeId?.startsWith('dp_') || data.providerTransactionId!==data.providerDisputeId) return exception('Dispute provider identity is inconsistent');
    if (!Number.isSafeInteger(data.amount) || data.amount<=0 || data.currency!==p.currency) return exception('Dispute amount or currency is invalid');
    if (d && (d.payment_id!==p.id || d.merchant_id!==p.merchant_id || d.currency!==p.currency || BigInt(d.amount)!==BigInt(data.amount))) return exception('Provider dispute identity contradicts recorded ownership or principal');
    if (type==='dispute.closed' && !['MERCHANT_WON','MERCHANT_LOST'].includes(data.outcome??'')) return exception('Dispute close requires a confirmed supported outcome');
    if (!d && type==='dispute.closed') {
      // Validate provider correlation before deferring a missing opening. No
      // financial admission or workflow transition is attempted until it exists.
      if (!await this.providerMatches(tx,p,lots,data)) return exception('Dispute provider relationship contradicts known captures or is unresolved');
      throw new RetryableWebhookError('Dispute close arrived before its open prerequisite');
    }
    if (d) {
      if (!allocations.length || allocations.reduce((sum,a)=>sum+BigInt(a.gross_principal),0n)!==BigInt(d.amount)
        || allocations.some(a=>a.status==='PLANNED' || a.status!==d.status || a.outcome!==d.outcome)) return exception('Dispute lacks coherent applied capture allocation evidence');
      if (!await this.providerMatches(tx,p,lots.filter(l=>allocations.some(a=>a.capture_lot_id===l.id)),data)) return exception('Dispute provider relationship contradicts frozen captures or is unresolved');
      for (const a of allocations) {
        const journals=await tx<{id:string}[]>`select id from public.ledger_transactions where status='POSTED' and merchant_id=${p.merchant_id} and currency=${p.currency}
          and ((id=${a.open_journal_id} and business_type='DISPUTE_OPEN' and business_id=${d.id})
            or (id=${a.close_journal_id} and business_type='DISPUTE_CLOSE' and business_id=${d.id}))`;
        if ((BigInt(a.funded_hold)>0n && !journals.some(j=>j.id===a.open_journal_id))
          || (d.status==='CLOSED' && (BigInt(a.held)>0n || d.outcome==='MERCHANT_LOST') && !journals.some(j=>j.id===a.close_journal_id))) return exception('Dispute journal evidence is incomplete');
      }
      if (d.status==='CLOSED') {
        if (type==='dispute.closed' && data.outcome!==d.outcome) return exception('Confirmed terminal dispute outcomes conflict');
        return this.dispose(tx,inboxId); // a repeated open cannot reopen a closed case
      }
      if (type==='dispute.opened') return this.dispose(tx,inboxId);
    }
    const conflict=await this.historyConflict(tx,p,lots);
    if (conflict) return exception(conflict);
    if (!['CAPTURED','PARTIALLY_REFUNDED','DISPUTED'].includes(p.status)) return exception(`Dispute cannot safely change payment state ${p.status}; F05/F06 review required`);
    if (!d) {
      const id=randomUUID();
      let assignments:ReturnType<typeof allocateRefundFifo>;
      try {
        // The shared FIFO helper allocates disjoint principal, regardless of the
        // consuming operation. Dispute replay uses persisted rows above.
        assignments=allocateRefundFifo({merchantId:p.merchant_id,paymentId:p.id,currency:p.currency,refundId:id,gross:BigInt(data.amount),lots:lots.map(l=>({
          id:l.id,captureAttemptId:l.capture_attempt_id,merchantId:p.merchant_id,paymentId:p.id,currency:p.currency,financialCapturedAtMicros:BigInt(l.financial_micros),
          originalGross:BigInt(l.original_gross),originalFee:BigInt(l.original_fee),confirmedRefundGross:BigInt(l.refunded),reservedRefundGross:BigInt(l.reserved),
          activeDisputeGross:BigInt(l.disputed),lostDisputeGross:BigInt(l.lost),
        }))});
      } catch { return exception('Dispute principal overlaps consumed/reserved exposure or exceeds capture capacity'); }
      const selected=lots.filter(l=>assignments.some(a=>a.lotId===l.id));
      if (!await this.providerMatches(tx,p,selected,data)) return exception('Dispute provider relationship contradicts selected captures or is unresolved');
      await tx`insert into public.disputes (id,merchant_id,payment_id,provider_dispute_id,status,amount,currency,opened_at)
        values (${id},${p.merchant_id},${p.id},${data.providerDisputeId},'OPEN',${data.amount},${p.currency},now())`;
      const lines:LedgerLine[]=[]; const funding=new Map<string,bigint>();
      for (const a of assignments) {
        const l=lots.find(l=>l.id===a.lotId)!;
        const free=this.entitlement(l)-BigInt(l.held);
        const held=free>0n?(a.gross<free?a.gross:free):0n;
        funding.set(l.id,held);
        this.line(lines,p,l.settlement_state==='FINALIZED'?'MERCHANT_AVAILABLE':'MERCHANT_PENDING',held,'debit');
        this.line(lines,p,'DISPUTE_CLEARING',held,'credit');
      }
      const journal=lines.length?await this.post(tx,p,'DISPUTE_OPEN',id,lines):null;
      for (const a of assignments) await tx`insert into public.dispute_capture_allocations
        (dispute_id,capture_lot_id,payment_id,merchant_id,currency,gross_principal,funded_hold,unfunded_exposure,status,open_journal_id)
        values (${id},${a.lotId},${p.id},${p.merchant_id},${p.currency},${a.gross.toString()},${funding.get(a.lotId)!.toString()},
          ${(a.gross-funding.get(a.lotId)!).toString()},'OPEN',${journal})`;
      await this.workflow(tx,p,id,'dispute.opened','DISPUTED',data.providerDisputeId);
    } else {
      const [existing]=await tx`select id from public.ledger_transactions where business_type='DISPUTE_CLOSE' and business_id=${d.id}`;
      if (existing) return exception('Open dispute already has unapplied close journal evidence');
      const lines:LedgerLine[]=[];
      for (const a of allocations) {
        const l=lots.find(l=>l.id===a.capture_lot_id)!; const gross=BigInt(a.gross_principal); const held=BigInt(a.held);
        this.line(lines,p,'DISPUTE_CLEARING',held,'debit');
        if (data.outcome==='MERCHANT_WON') this.line(lines,p,l.settlement_state==='FINALIZED'?'MERCHANT_AVAILABLE':'MERCHANT_PENDING',held,'credit');
        else {
          const adjustment=await reduceDisputeHolds(tx,this.ledger,{lotId:l.id,paymentId:p.id,merchantId:p.merchant_id,currency:p.currency,
            settled:l.settlement_state==='FINALIZED',survivingEntitlement:this.entitlement(l)-gross,inboxId,cause:'DISPUTE',causeId:d.id});
          const extra=gross-held;
          const ownPending=this.entitlement(l)-BigInt(l.held)+adjustment.released;
          const pending=l.settlement_state==='FINALIZED'?0n:(ownPending>0n?(ownPending<extra?ownPending:extra):0n);
          this.line(lines,p,'MERCHANT_PENDING',pending,'debit'); this.line(lines,p,'MERCHANT_AVAILABLE',extra-pending,'debit');
          this.line(lines,p,l.settlement_state==='FINALIZED'?'PLATFORM_CASH':'PSP_CLEARING',gross,'credit');
        }
      }
      const journal=lines.length?await this.post(tx,p,'DISPUTE_CLOSE',d.id,lines):null;
      await tx`update public.dispute_capture_allocations set status='CLOSED',outcome=${data.outcome!},close_journal_id=${journal} where dispute_id=${d.id}`;
      await tx`update public.disputes set status='CLOSED',outcome=${data.outcome!},closed_at=now(),updated_at=now() where id=${d.id}`;
      const [open]=await tx<{found:boolean}[]>`select exists(select 1 from public.disputes where payment_id=${p.id} and status='OPEN') as found`;
      const status:PaymentStatus=open.found?'DISPUTED':BigInt(p.refunded_amount)===BigInt(p.captured_amount)?'REFUNDED':BigInt(p.refunded_amount)>0n?'PARTIALLY_REFUNDED':'CAPTURED';
      await this.workflow(tx,p,d.id,'dispute.closed',status,data.providerDisputeId);
    }
    return this.dispose(tx,inboxId);
  }

  private entitlement(l:Lot):bigint { return BigInt(l.original_gross)-BigInt(l.original_fee)-(BigInt(l.refunded)-BigInt(l.returned_fee))-BigInt(l.lost); }
  private line(lines:LedgerLine[],p:Payment,code:LedgerLine['accountCode'],amount:bigint,side:'debit'|'credit'):void {
    if (amount>0n) lines.push({accountCode:code,merchantId:code.startsWith('MERCHANT_') || code==='DISPUTE_CLEARING'?p.merchant_id:null,[side]:exactLedgerAmount(amount)});
  }
  private post(tx:DbTransaction,p:Payment,kind:string,id:string,lines:LedgerLine[]):Promise<string> {
    exactLedgerAmount(lines.reduce((sum,l)=>sum+BigInt(l.debit??0),0n));
    return this.ledger.post(tx,{merchantId:p.merchant_id,businessType:kind,businessId:id,currency:p.currency,description:`${kind} ${id}`,
      lines:lines.sort((a,b)=>a.accountCode.localeCompare(b.accountCode))});
  }
  private async workflow(tx:DbTransaction,p:Payment,id:string,action:string,status:PaymentStatus,provider:string):Promise<void> {
    await tx`update public.payments set status=${status},version=version+1,updated_at=now() where id=${p.id}`;
    await this.audit.append(tx,{merchantId:p.merchant_id,actor:{type:'PROVIDER',id:provider},action,targetType:'payment',targetId:p.id,
      metadata:{disputeId:id,accountingPolicy:'CAPTURE_FIFO_V1'}});
  }
  private async lockPayment(tx:DbTransaction,paymentId:string,merchantId:string):Promise<Payment> {
    const [identity]=await tx<{merchant_id:string;currency:string}[]>`select merchant_id::text,currency from public.payments where id=${paymentId} and merchant_id=${merchantId}`;
    if (!identity) throw new RetryableWebhookError('Dispute payment ownership is not visible');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${identity.merchant_id}:${identity.currency}`},0))`;
    const [scope]=await tx<{status:string}[]>`select status from public.capture_accounting_scopes where merchant_id=${identity.merchant_id} and currency=${identity.currency} for update`;
    this.assertActiveScope(scope?.status??'MISSING');
    const [p]=await tx<Payment[]>`select id,merchant_id,currency,status,captured_amount::text,refunded_amount::text from public.payments where id=${paymentId} and merchant_id=${merchantId} for no key update`;
    if (!p || p.currency!==identity.currency) throw new DomainError('PAYMENT_SCOPE_CHANGED','Payment identity changed',409);
    return p;
  }
  private async lockLots(tx:DbTransaction,p:Payment):Promise<Lot[]> {
    await tx`select id from public.payment_attempts where payment_id=${p.id} and kind='CAPTURE' order by id for update`;
    await tx`select id from public.refunds where payment_id=${p.id} order by id for update`;
    await tx`select id from public.disputes where payment_id=${p.id} order by id for update`;
    await tx`select id from public.capture_accounting_lots where payment_id=${p.id} order by capture_attempt_id for update`;
    await tx`select id from public.dispute_capture_allocations where payment_id=${p.id} order by capture_lot_id,id for update`;
    await tx`select id from public.refund_capture_allocations where payment_id=${p.id} order by capture_lot_id,id for update`;
    return tx<Lot[]>`select l.id,l.capture_attempt_id,a.provider_transaction_id as provider_reference,l.original_gross::text,l.original_fee::text,
      (extract(epoch from l.financial_captured_at)*1000000)::bigint::text as financial_micros,l.settlement_state,
      (l.origin='NEW_CAPTURE' and l.eligible_at is not null and v.original_valid and v.journal_id=l.capture_journal_id and l.merchant_id=${p.merchant_id} and l.currency=${p.currency}) as verified,
      coalesce(r.refunded,0)::text as refunded,coalesce(r.fee,0)::text as returned_fee,coalesce(r.reserved,0)::text as reserved,
      coalesce(d.disputed,0)::text as disputed,coalesce(d.lost,0)::text as lost,coalesce(d.held,0)::text as held
      from public.capture_accounting_lots l join public.payment_attempts a on a.id=l.capture_attempt_id
      join public.capture_accounting_legacy_inventory v on v.capture_attempt_id=l.capture_attempt_id
      left join lateral (select sum(confirmed_gross) filter(where status='CONFIRMED') as refunded,sum(confirmed_fee) filter(where status='CONFIRMED') as fee,
        sum(reserved_gross) filter(where status='RESERVED') as reserved from public.refund_capture_allocations where capture_lot_id=l.id) r on true
      left join lateral (select sum(gross_principal) filter(where status in ('PLANNED','OPEN')) as disputed,
        sum(gross_principal) filter(where status='CLOSED' and outcome='MERCHANT_LOST') as lost,
        sum(funded_hold+coalesce(e.delta,0)) filter(where status in ('PLANNED','OPEN')) as held from public.dispute_capture_allocations d
        left join lateral (select sum(hold_delta) as delta from public.dispute_hold_effects where allocation_id=d.id) e on true where capture_lot_id=l.id) d on true
      where l.payment_id=${p.id} order by l.financial_captured_at,l.capture_attempt_id`;
  }
  private async historyConflict(tx:DbTransaction,p:Payment,lots:Lot[]):Promise<string|null> {
    if (!lots.length || lots.some(l=>!l.verified) || lots.reduce((sum,l)=>sum+BigInt(l.original_gross),0n)!==BigInt(p.captured_amount)
      || lots.reduce((sum,l)=>sum+BigInt(l.refunded),0n)!==BigInt(p.refunded_amount)) return 'Capture ownership or historical totals require reconciliation';
    const [history]=await tx<{blocked:boolean}[]>`select
      exists(select 1 from public.accounting_exceptions where merchant_id=${p.merchant_id} and currency=${p.currency} and status='OPEN')
      or exists(select 1 from public.refunds r where payment_id=${p.id} and status in ('PENDING','PROCESSING','SUCCEEDED') and
        (select coalesce(sum(reserved_gross) filter(where status<>'RELEASED'),0) from public.refund_capture_allocations where refund_id=r.id)<>r.amount)
      or exists(select 1 from public.disputes d where payment_id=${p.id} and
        ((select coalesce(sum(gross_principal),0) from public.dispute_capture_allocations where dispute_id=d.id)<>d.amount
        or exists(select 1 from public.dispute_capture_allocations a where dispute_id=d.id and (a.status<>d.status or a.outcome is distinct from d.outcome))))
      or exists(select 1 from public.settlement_items where payment_id=${p.id} and capture_lot_id is null) as blocked`;
    return history.blocked?'Blocking exception or unallocated legacy history requires review':null;
  }
  private async providerMatches(tx:DbTransaction,p:Payment,lots:Lot[],data:NonNullable<ProviderEvent['data']>):Promise<boolean> {
    if (!lots.length) return false;
    const references=new Set(lots.map(l=>l.provider_reference)); const pi=[...references][0];
    if (references.size!==1 || !pi?.startsWith('pi_') || (data.paymentIntentId && data.paymentIntentId!==pi)) return false;
    // A charge can establish the relationship when the normalized event omits
    // PaymentIntent. Only matching successful CAPTURE command mirrors qualify.
    const mirrors=await tx<{payment_attempt_id:string;payment_id:string;merchant_id:string;currency:string;payment_intent_id:string|null;charge_id:string|null;amount:string;provider_transaction_id:string}[]>`select
      payment_attempt_id,payment_id,merchant_id,currency,payment_intent_id,charge_id,amount::text,provider_transaction_id from public.provider_transactions where provider='STRIPE' and operation='CAPTURE'
      and provider_idempotency_key='capture:'||payment_attempt_id::text
      and payment_attempt_id in (select capture_attempt_id from public.capture_accounting_lots where id in ${tx(lots.map(l=>l.id))})`;
    if (mirrors.some(m=>m.payment_id!==p.id || m.merchant_id!==p.merchant_id || m.currency!==p.currency || m.provider_transaction_id!==pi
      || m.amount!==lots.find(l=>l.capture_attempt_id===m.payment_attempt_id)?.original_gross || (m.payment_intent_id && m.payment_intent_id!==pi))) return false;
    if (data.chargeId && mirrors.some(m=>m.charge_id && m.charge_id!==data.chargeId)) return false;
    return !!data.paymentIntentId || !!data.chargeId && lots.every(l=>mirrors.some(m=>m.payment_attempt_id===l.capture_attempt_id && m.charge_id===data.chargeId && m.payment_intent_id===pi));
  }
  private async exception(tx:DbTransaction,inboxId:string,p:Payment,lots:Lot[],d:Dispute|undefined,reason:string,data:NonNullable<ProviderEvent['data']>):Promise<Disposition> {
    const conflicts=await tx<{id:string;dispute_id:string;capture_lot_id:string;gross_principal:string}[]>`select id,dispute_id,capture_lot_id,gross_principal::text from public.dispute_capture_allocations where payment_id=${p.id} order by id`;
    const refunds=await tx<{id:string;refund_id:string;capture_lot_id:string;reserved_gross:string;status:string}[]>`select id,refund_id,capture_lot_id,reserved_gross::text,status from public.refund_capture_allocations where payment_id=${p.id} order by id`;
    const mirrors=await tx<{id:string;payment_attempt_id:string|null;provider_transaction_id:string;payment_intent_id:string|null;charge_id:string|null;provider_idempotency_key:string}[]>`select id,payment_attempt_id,
      provider_transaction_id,payment_intent_id,charge_id,provider_idempotency_key from public.provider_transactions where provider='STRIPE' and operation='CAPTURE' and payment_id=${p.id} order by id`;
    const [created]=await tx<{id:string}[]>`insert into public.accounting_exceptions (merchant_id,currency,payment_id,category,source_kind,evidence_key,provider_event_id,dispute_id,observed_conflict)
      values (${p.merchant_id},${p.currency},${p.id},'AMBIGUOUS_PROVIDER_NET_EFFECT','WEBHOOK',${`webhook:${inboxId}`},${inboxId},${d?.payment_id===p.id && d.merchant_id===p.merchant_id && d.currency===p.currency?d.id:null},
        ${tx.json({reason,event:{...data},recordedDispute:d?{...d}:null,conflicts,refunds,providerMirrors:mirrors,captures:lots.map(l=>({lotId:l.id,attemptId:l.capture_attempt_id,paymentIntentId:l.provider_reference}))})}) on conflict do nothing returning id`;
    const [row]=created?[created]:await tx<{id:string}[]>`select id from public.accounting_exceptions where merchant_id=${p.merchant_id} and currency=${p.currency}
      and category='AMBIGUOUS_PROVIDER_NET_EFFECT' and evidence_key=${`webhook:${inboxId}`}`;
    for (const l of lots) await tx`insert into public.accounting_exception_lots (exception_id,capture_lot_id,payment_id,merchant_id,currency)
      values (${row.id},${l.id},${p.id},${p.merchant_id},${p.currency}) on conflict do nothing`;
    await tx`update public.webhook_events set status='ACCOUNTING_EXCEPTION',processed_at=null,locked_at=null,last_error=${reason},updated_at=now() where id=${inboxId}`;
    return 'ACCOUNTING_EXCEPTION';
  }
  private async dispose(tx:DbTransaction,inboxId:string):Promise<Disposition> {
    await tx`update public.webhook_events set status='PROCESSED',processed_at=coalesce(processed_at,now()),locked_at=null,updated_at=now() where id=${inboxId}`;
    return 'PROCESSED';
  }
}
