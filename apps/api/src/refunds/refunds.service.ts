import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthActor } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import { IdempotencyService, IdempotentResult } from '../common/idempotency.service';
import { DatabaseService, DbTransaction } from '../database/database.service';
import { allocateRefundFee, type LedgerLine } from '../ledger/ledger.types';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentStateMachine, PaymentStatus } from '../payments/payment-state.machine';
import { CreateRefundDto } from './refunds.dto';

interface RefundPayment { id: string; status: PaymentStatus; captured_amount: string; refunded_amount: string; platform_fee_amount: string; currency: string }
interface RefundEvent { merchantId: string; paymentId: string; refundId: string; providerTransactionId: string; amount: number; currency: string }

@Injectable()
export class RefundsService {
  constructor(private readonly database: DatabaseService, private readonly idempotency: IdempotencyService, private readonly outbox: OutboxService, private readonly audit: AuditService, private readonly ledger: LedgerService) {}

  create(actor: AuthActor, paymentId: string, key: string, dto: CreateRefundDto): Promise<IdempotentResult<Record<string, unknown>>> {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'A merchant context is required', 403);
    const merchantId = actor.merchantId;
    return this.idempotency.execute({ merchantId, operation: `refund.create:${paymentId}`, key, payload: dto, responseStatus: 202, action: async (tx) => {
      const [payment] = await tx<RefundPayment[]>`select id, status, captured_amount::text, refunded_amount::text, platform_fee_amount::text, currency from payments where id=${paymentId} and merchant_id=${merchantId} for update`;
      if (!payment) throw new DomainError('PAYMENT_NOT_FOUND', 'Payment was not found', 404);
      if (!['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status)) throw new DomainError('PAYMENT_NOT_REFUNDABLE', `Payment in ${payment.status} cannot be refunded`, 409);
      const [reserved] = await tx<{ total: string }[]>`select coalesce(sum(amount),0)::text as total from refunds where payment_id=${paymentId} and status in ('PENDING','PROCESSING','SUCCEEDED')`;
      const remaining = Number(payment.captured_amount) - Number(reserved.total);
      if (dto.amount > remaining) throw new DomainError('REFUND_EXCEEDS_CAPTURED_AMOUNT', 'Refund would exceed the unrefunded captured amount', 422, { remaining });
      const refundId = randomUUID();
      const [capture] = await tx<{ provider_transaction_id: string }[]>`
        select provider_transaction_id from payment_attempts
        where payment_id=${paymentId} and kind='CAPTURE' and status='SUCCEEDED' and provider_transaction_id is not null
        order by created_at desc limit 1`;
      if (!capture) throw new DomainError('PROVIDER_REFERENCE_MISSING', 'The captured payment has no Stripe PaymentIntent reference', 409);
      await tx`insert into refunds (id, merchant_id, payment_id, amount, currency, reason) values (${refundId}, ${merchantId}, ${paymentId}, ${dto.amount}, ${payment.currency}, ${dto.reason ?? null})`;
      await this.outbox.add(tx, { aggregateType: 'REFUND', aggregateId: refundId, eventType: 'provider.refund.requested', payload: { merchantId, paymentId, refundId, amount: dto.amount, currency: payment.currency, providerPaymentId: capture.provider_transaction_id, idempotencyKey: `refund:${refundId}` } });
      await this.audit.append(tx, { merchantId, actor, action: 'refund.requested', targetType: 'payment', targetId: paymentId, metadata: { refundId, amount: dto.amount } });
      return { id: refundId, paymentId, status: 'PENDING', amount: dto.amount, currency: payment.currency };
    }});
  }

  async applySucceeded(tx: DbTransaction, event: RefundEvent): Promise<void> {
    const [refund] = await tx<{ status: string; amount: string }[]>`select status, amount::text from refunds where id=${event.refundId} and merchant_id=${event.merchantId} for update`;
    if (!refund) throw new DomainError('REFUND_NOT_FOUND', 'Webhook references an unknown refund', 409);
    if (refund.status === 'SUCCEEDED') return;
    const [payment] = await tx<RefundPayment[]>`select id, status, captured_amount::text, refunded_amount::text, platform_fee_amount::text, currency from payments where id=${event.paymentId} and merchant_id=${event.merchantId} for update`;
    if (!payment || Number(refund.amount) !== event.amount || payment.currency !== event.currency) throw new DomainError('PROVIDER_REFUND_MISMATCH', 'Provider refund details do not match internal intent', 409);
    const [allocated] = await tx<{ total: string }[]>`select coalesce(sum(platform_fee_amount),0)::text as total from refunds where payment_id=${event.paymentId} and status='SUCCEEDED'`;
    const newRefunded = Number(payment.refunded_amount) + event.amount;
    const feeDelta = allocateRefundFee(Number(payment.platform_fee_amount), newRefunded, Number(payment.captured_amount), Number(allocated.total));
    const merchantDebit = event.amount - feeDelta;
    const pending = await this.ledger.merchantBalance(tx, event.merchantId, event.currency, 'MERCHANT_PENDING');
    const pendingDebit = Math.min(Math.max(0, pending), merchantDebit);
    const availableDebit = merchantDebit - pendingDebit;
    const [settled] = await tx<{ found: boolean }[]>`select exists(select 1 from settlement_items i join settlements s on s.id=i.settlement_id where i.payment_id=${event.paymentId} and s.status='SUCCEEDED') as found`;
    const assetAccount = settled?.found ? 'PLATFORM_CASH' : 'PSP_CLEARING';
    const lines: LedgerLine[] = [
      ...(pendingDebit ? [{ accountCode: 'MERCHANT_PENDING' as const, merchantId: event.merchantId, debit: pendingDebit }] : []),
      ...(availableDebit ? [{ accountCode: 'MERCHANT_AVAILABLE' as const, merchantId: event.merchantId, debit: availableDebit }] : []),
      ...(feeDelta ? [{ accountCode: 'PLATFORM_FEE_REFUNDS' as const, merchantId: null, debit: feeDelta }] : []),
      { accountCode: assetAccount, merchantId: null, credit: event.amount },
    ];
    await this.ledger.post(tx, { merchantId: event.merchantId, businessType: 'REFUND', businessId: event.refundId, currency: event.currency, description: `Refund ${event.refundId}`, lines });
    const status = PaymentStateMachine.refundSucceeded(payment.status, newRefunded, Number(payment.captured_amount));
    await tx`update refunds set status='SUCCEEDED', platform_fee_amount=${feeDelta}, provider_transaction_id=${event.providerTransactionId}, updated_at=now() where id=${event.refundId}`;
    await tx`update payments set status=${status}, refunded_amount=${newRefunded}, version=version+1, updated_at=now() where id=${event.paymentId}`;
    await this.audit.append(tx, { merchantId: event.merchantId, actor: { type: 'PROVIDER', id: event.providerTransactionId }, action: 'refund.succeeded', targetType: 'payment', targetId: event.paymentId, metadata: { refundId: event.refundId, amount: event.amount, feeDelta } });
  }

  async applyFailed(tx: DbTransaction, event: RefundEvent): Promise<void> {
    await tx`update refunds set status='FAILED', provider_transaction_id=${event.providerTransactionId}, failure_code='PROVIDER_FAILED', updated_at=now() where id=${event.refundId} and merchant_id=${event.merchantId} and status <> 'SUCCEEDED'`;
  }
}
