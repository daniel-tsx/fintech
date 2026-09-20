import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import type { DbTransaction } from '../database/database.service';
import { DisputesService } from '../disputes/disputes.service';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentStateMachine, PaymentStatus } from '../payments/payment-state.machine';
import { RefundsService } from '../refunds/refunds.service';
import { SettlementsService } from '../settlements/settlements.service';
import type { MockPspEvent } from './webhook.types';
import { RetryableWebhookError } from './webhook.types';

interface WebhookPayment { id: string; merchant_id: string; status: PaymentStatus; capture_method: 'MANUAL' | 'AUTOMATIC'; amount: string; authorized_amount: string; captured_amount: string; refunded_amount: string; platform_fee_amount: string; currency: string }

@Injectable()
export class WebhookBusinessService {
  constructor(private readonly ledger: LedgerService, private readonly outbox: OutboxService, private readonly audit: AuditService, private readonly refunds: RefundsService, private readonly disputes: DisputesService, private readonly settlements: SettlementsService) {}

  async handle(tx: DbTransaction, event: MockPspEvent): Promise<void> {
    switch (event.type) {
      case 'payment.authorized': return this.authorizationSucceeded(tx, event);
      case 'payment.authorization_failed': return this.authorizationFailed(tx, event);
      case 'payment.capture_succeeded': return this.captureSucceeded(tx, event);
      case 'payment.capture_failed': return this.captureFailed(tx, event);
      case 'payment.cancelled': return this.cancelled(tx, event);
      case 'refund.succeeded':
        if (!event.data.refundId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Refund event has no refund id', 409);
        return this.refunds.applySucceeded(tx, { ...event.data, refundId: event.data.refundId });
      case 'refund.failed':
        if (!event.data.refundId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Refund event has no refund id', 409);
        return this.refunds.applyFailed(tx, { ...event.data, refundId: event.data.refundId });
      case 'dispute.opened':
        if (!event.data.providerDisputeId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Dispute event has no provider dispute id', 409);
        return this.disputes.open(tx, { ...event.data, providerDisputeId: event.data.providerDisputeId });
      case 'dispute.closed':
        if (!event.data.providerDisputeId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Dispute event has no provider dispute id', 409);
        return this.disputes.close(tx, { ...event.data, providerDisputeId: event.data.providerDisputeId });
      case 'settlement.completed':
        if (!event.data.settlementId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Settlement event has no settlement id', 409);
        return this.settlements.complete(tx, event.data.settlementId);
      default: return;
    }
  }

  private async authorizationSucceeded(tx: DbTransaction, event: MockPspEvent): Promise<void> {
    if (!event.data.attemptId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Authorization event has no attempt id', 409);
    const [attempt] = await tx<{ status: string; amount: string }[]>`select status, amount::text from payment_attempts where id=${event.data.attemptId} for update`;
    if (!attempt) throw new RetryableWebhookError('Authorization attempt is not visible yet');
    if (attempt.status === 'SUCCEEDED') return;
    const payment = await this.lockPayment(tx, event);
    if (Number(attempt.amount) !== event.data.amount || Number(payment.amount) !== event.data.amount) throw new DomainError('PROVIDER_AMOUNT_MISMATCH', 'Provider authorization amount does not match internal intent', 409);
    const status = PaymentStateMachine.authorized(payment.status);
    await tx`update payment_attempts set status='SUCCEEDED', provider_transaction_id=${event.data.providerTransactionId}, updated_at=now() where id=${event.data.attemptId}`;
    await tx`update payments set status=${status}, authorized_amount=${event.data.amount}, authorized_at=now(), version=version+1, updated_at=now() where id=${payment.id}`;
    await this.audit.append(tx, { merchantId: payment.merchant_id, actor: { type: 'PROVIDER', id: event.data.providerTransactionId }, action: 'payment.authorized', targetType: 'payment', targetId: payment.id, metadata: { amount: event.data.amount } });
    if (payment.capture_method === 'AUTOMATIC') {
      const captureAttemptId = randomUUID();
      await tx`insert into payment_attempts (id, merchant_id, payment_id, kind, amount, currency, scenario) select ${captureAttemptId}, merchant_id, id, 'CAPTURE', ${event.data.amount}, currency, scenario from payment_attempts where id=${event.data.attemptId}`;
      await tx`update payments set status='CAPTURE_PENDING', version=version+1, updated_at=now() where id=${payment.id}`;
      await this.outbox.add(tx, { aggregateType: 'PAYMENT_ATTEMPT', aggregateId: captureAttemptId, eventType: 'provider.capture.requested', payload: { merchantId: payment.merchant_id, paymentId: payment.id, attemptId: captureAttemptId, amount: event.data.amount, currency: event.data.currency, scenario: 'SUCCESS', idempotencyKey: `capture:${captureAttemptId}` } });
    }
  }

  private async authorizationFailed(tx: DbTransaction, event: MockPspEvent): Promise<void> {
    const payment = await this.lockPayment(tx, event); const status = PaymentStateMachine.authorizationFailed(payment.status);
    if (event.data.attemptId) await tx`update payment_attempts set status='FAILED', provider_transaction_id=${event.data.providerTransactionId}, failure_code='DECLINED', updated_at=now() where id=${event.data.attemptId}`;
    await tx`update payments set status=${status}, version=version+1, updated_at=now() where id=${payment.id}`;
  }

  private async captureSucceeded(tx: DbTransaction, event: MockPspEvent): Promise<void> {
    if (!event.data.attemptId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Capture event has no attempt id', 409);
    const [attempt] = await tx<{ status: string; amount: string }[]>`select status, amount::text from payment_attempts where id=${event.data.attemptId} for update`;
    if (!attempt) throw new RetryableWebhookError('Capture attempt is not visible yet');
    if (attempt.status === 'SUCCEEDED') return;
    const payment = await this.lockPayment(tx, event);
    if (Number(attempt.amount) !== event.data.amount || payment.currency !== event.data.currency) throw new DomainError('PROVIDER_AMOUNT_MISMATCH', 'Provider capture does not match internal intent', 409);
    const newCaptured = Number(payment.captured_amount) + event.data.amount;
    if (newCaptured > Number(payment.authorized_amount)) throw new DomainError('CAPTURE_EXCEEDS_AUTHORIZATION', 'Provider capture exceeds authorized amount', 409);
    const [merchant] = await tx<{ fee_bps: number; fixed_fee_minor: string }[]>`select fee_bps, fixed_fee_minor::text from merchants where id=${payment.merchant_id}`;
    const cumulativeFee = Math.min(newCaptured, Math.floor((newCaptured * merchant.fee_bps) / 10_000) + Number(merchant.fixed_fee_minor));
    const fee = cumulativeFee - Number(payment.platform_fee_amount); const net = event.data.amount - fee;
    await this.ledger.post(tx, { merchantId: payment.merchant_id, businessType: 'CAPTURE', businessId: event.data.attemptId, currency: payment.currency, description: `Capture ${event.data.attemptId}`, lines: [
      { accountCode: 'PSP_CLEARING', merchantId: null, debit: event.data.amount },
      ...(net ? [{ accountCode: 'MERCHANT_PENDING' as const, merchantId: payment.merchant_id, credit: net }] : []),
      ...(fee ? [{ accountCode: 'PLATFORM_FEE_REVENUE' as const, merchantId: null, credit: fee }] : []),
    ]});
    await tx`update payment_attempts set status='SUCCEEDED', provider_transaction_id=${event.data.providerTransactionId}, updated_at=now() where id=${event.data.attemptId}`;
    await tx`update payments set status=${PaymentStateMachine.captureSucceeded(payment.status)}, captured_amount=${newCaptured}, platform_fee_amount=${cumulativeFee}, captured_at=coalesce(captured_at,now()), version=version+1, updated_at=now() where id=${payment.id}`;
    await this.audit.append(tx, { merchantId: payment.merchant_id, actor: { type: 'PROVIDER', id: event.data.providerTransactionId }, action: 'payment.capture_succeeded', targetType: 'payment', targetId: payment.id, metadata: { attemptId: event.data.attemptId, gross: event.data.amount, fee, net } });
  }

  private async captureFailed(tx: DbTransaction, event: MockPspEvent): Promise<void> {
    const payment = await this.lockPayment(tx, event);
    if (event.data.attemptId) await tx`update payment_attempts set status='FAILED', provider_transaction_id=${event.data.providerTransactionId}, failure_code='PROVIDER_FAILED', updated_at=now() where id=${event.data.attemptId}`;
    await tx`update payments set status=${PaymentStateMachine.captureFailed(payment.status, Number(payment.captured_amount))}, version=version+1, updated_at=now() where id=${payment.id}`;
  }

  private async cancelled(tx: DbTransaction, event: MockPspEvent): Promise<void> {
    const payment = await this.lockPayment(tx, event);
    if (event.data.attemptId) await tx`update payment_attempts set status='SUCCEEDED', provider_transaction_id=${event.data.providerTransactionId}, updated_at=now() where id=${event.data.attemptId}`;
    if (payment.status !== 'CANCELLED') await tx`update payments set status=${PaymentStateMachine.cancelled(payment.status)}, version=version+1, updated_at=now() where id=${payment.id}`;
  }

  private async lockPayment(tx: DbTransaction, event: MockPspEvent): Promise<WebhookPayment> {
    const [payment] = await tx<WebhookPayment[]>`select id, merchant_id, status, capture_method, amount::text, authorized_amount::text, captured_amount::text, refunded_amount::text, platform_fee_amount::text, currency from payments where id=${event.data.paymentId} and merchant_id=${event.data.merchantId} for update`;
    if (!payment) throw new RetryableWebhookError('Payment is not visible yet');
    return payment;
  }
}
