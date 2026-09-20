import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/domain-error';
import { AuditService } from '../audit/audit.service';
import type { DbTransaction } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentStateMachine, PaymentStatus } from '../payments/payment-state.machine';

export interface DisputeEvent { merchantId: string; paymentId: string; providerDisputeId: string; amount: number; currency: string; outcome?: 'MERCHANT_WON' | 'MERCHANT_LOST' }

@Injectable()
export class DisputesService {
  constructor(private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  async open(tx: DbTransaction, event: DisputeEvent): Promise<void> {
    const existing = await tx`select id from disputes where provider_dispute_id=${event.providerDisputeId}`;
    if (existing[0]) return;
    const [payment] = await tx<{ status: PaymentStatus; captured_amount: string; refunded_amount: string; currency: string }[]>`select status, captured_amount::text, refunded_amount::text, currency from payments where id=${event.paymentId} and merchant_id=${event.merchantId} for update`;
    if (!payment) throw new DomainError('PAYMENT_NOT_FOUND', 'Dispute references an unknown payment', 409);
    if (payment.currency !== event.currency || event.amount <= 0 || event.amount > Number(payment.captured_amount) - Number(payment.refunded_amount)) throw new DomainError('INVALID_DISPUTE_AMOUNT', 'Dispute amount or currency does not match the payment', 409);
    const [settled] = await tx<{ found: boolean }[]>`select exists(select 1 from settlement_items i join settlements s on s.id=i.settlement_id where i.payment_id=${event.paymentId} and s.status='SUCCEEDED') as found`;
    const source = settled?.found ? 'MERCHANT_AVAILABLE' : 'MERCHANT_PENDING';
    const [row] = await tx<{ id: string }[]>`insert into disputes (merchant_id, payment_id, provider_dispute_id, status, amount, currency, source_account_code, opened_at) values (${event.merchantId}, ${event.paymentId}, ${event.providerDisputeId}, 'OPEN', ${event.amount}, ${event.currency}, ${source}, now()) returning id`;
    await this.ledger.post(tx, { merchantId: event.merchantId, businessType: 'DISPUTE_OPEN', businessId: row.id, currency: event.currency, description: `Dispute hold ${event.providerDisputeId}`, lines: [
      { accountCode: source, merchantId: event.merchantId, debit: event.amount }, { accountCode: 'DISPUTE_CLEARING', merchantId: event.merchantId, credit: event.amount },
    ]});
    await tx`update payments set status=${PaymentStateMachine.disputeOpened(payment.status)}, version=version+1, updated_at=now() where id=${event.paymentId}`;
    await this.audit.append(tx, { merchantId: event.merchantId, actor: { type: 'PROVIDER', id: event.providerDisputeId }, action: 'dispute.opened', targetType: 'payment', targetId: event.paymentId, metadata: { disputeId: row.id, amount: event.amount } });
  }

  async close(tx: DbTransaction, event: DisputeEvent): Promise<void> {
    const [dispute] = await tx<{ id: string; status: string; amount: string; currency: string; source_account_code: 'MERCHANT_PENDING' | 'MERCHANT_AVAILABLE' }[]>`select id, status, amount::text, currency, source_account_code from disputes where provider_dispute_id=${event.providerDisputeId} and merchant_id=${event.merchantId} for update`;
    // A close can legitimately overtake the open event on an at-least-once provider channel.
    if (!dispute) throw new Error('Dispute close arrived before dispute open; retry after prerequisite');
    if (dispute.status === 'CLOSED') return;
    if (!event.outcome) throw new DomainError('DISPUTE_OUTCOME_REQUIRED', 'Dispute close event requires an outcome', 409);
    const amount = Number(dispute.amount);
    const destination = event.outcome === 'MERCHANT_WON' ? dispute.source_account_code : 'PLATFORM_CASH';
    await this.ledger.post(tx, { merchantId: event.merchantId, businessType: 'DISPUTE_CLOSE', businessId: dispute.id, currency: dispute.currency, description: `Dispute ${event.outcome.toLowerCase()}`, lines: [
      { accountCode: 'DISPUTE_CLEARING', merchantId: event.merchantId, debit: amount }, { accountCode: destination, merchantId: event.outcome === 'MERCHANT_WON' ? event.merchantId : null, credit: amount },
    ]});
    await tx`update disputes set status='CLOSED', outcome=${event.outcome}, closed_at=now(), updated_at=now() where id=${dispute.id}`;
    const [payment] = await tx<{ captured_amount: string; refunded_amount: string }[]>`select captured_amount::text, refunded_amount::text from payments where id=${event.paymentId} for update`;
    const restored: PaymentStatus = Number(payment.refunded_amount) === Number(payment.captured_amount) ? 'REFUNDED' : Number(payment.refunded_amount) > 0 ? 'PARTIALLY_REFUNDED' : 'CAPTURED';
    await tx`update payments set status=${restored}, version=version+1, updated_at=now() where id=${event.paymentId}`;
    await this.audit.append(tx, { merchantId: event.merchantId, actor: { type: 'PROVIDER', id: event.providerDisputeId }, action: 'dispute.closed', targetType: 'payment', targetId: event.paymentId, metadata: { outcome: event.outcome, amount } });
  }
}
