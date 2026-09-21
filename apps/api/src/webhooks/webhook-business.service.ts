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
import type { CorrelatedProviderEvent, InternalProviderEventType, ProviderEvent } from './webhook.types';
import { RetryableWebhookError } from './webhook.types';

interface WebhookPayment { id: string; merchant_id: string; status: PaymentStatus; capture_method: 'MANUAL' | 'AUTOMATIC'; amount: string; authorized_amount: string; captured_amount: string; refunded_amount: string; platform_fee_amount: string; currency: string }
interface WebhookAttempt { status: string; amount: string; merchant_id: string; payment_id: string; currency: string; provider_transaction_id: string | null }
interface ProviderReference { merchant_id: string; payment_id: string | null; payment_attempt_id: string | null; refund_id: string | null }

@Injectable()
export class WebhookBusinessService {
  constructor(private readonly ledger: LedgerService, private readonly outbox: OutboxService, private readonly audit: AuditService, private readonly refunds: RefundsService, private readonly disputes: DisputesService) {}

  async handle(tx: DbTransaction, event: ProviderEvent): Promise<void> {
    if (event.type === 'provider.unsupported' || !event.data) return;
    const correlated = await this.correlate(tx, event);
    await this.syncProviderMirror(tx, correlated);
    switch (correlated.type) {
      case 'payment.authorized': return this.authorizationSucceeded(tx, correlated);
      case 'payment.authorization_failed': return this.authorizationFailed(tx, correlated);
      case 'payment.capture_succeeded': return this.captureSucceeded(tx, correlated);
      case 'payment.capture_failed': return this.captureFailed(tx, correlated);
      case 'payment.cancelled': return this.cancelled(tx, correlated);
      case 'refund.succeeded':
        if (!correlated.data.refundId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Refund event has no refund id', 409);
        return this.refunds.applySucceeded(tx, { ...correlated.data, refundId: correlated.data.refundId });
      case 'refund.failed':
        if (!correlated.data.refundId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Refund event has no refund id', 409);
        return this.refunds.applyFailed(tx, { ...correlated.data, refundId: correlated.data.refundId });
      case 'dispute.opened':
        if (!correlated.data.providerDisputeId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Dispute event has no provider dispute id', 409);
        return this.disputes.open(tx, { ...correlated.data, providerDisputeId: correlated.data.providerDisputeId });
      case 'dispute.closed':
        if (!correlated.data.providerDisputeId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Dispute event has no provider dispute id', 409);
        return this.disputes.close(tx, { ...correlated.data, providerDisputeId: correlated.data.providerDisputeId });
    }
  }

  private async correlate(tx: DbTransaction, event: ProviderEvent): Promise<CorrelatedProviderEvent> {
    if (!event.data || event.type === 'provider.unsupported') throw new RetryableWebhookError('Unsupported events do not require correlation');
    const operation = this.operationFor(event.type);
    const [reference] = await tx<ProviderReference[]>`
      select merchant_id, payment_id, payment_attempt_id, refund_id
      from provider_transactions
      where provider='STRIPE'
        and (${operation}::text is null or operation=${operation})
        and (
          provider_transaction_id=${event.data.providerTransactionId}
          or payment_intent_id=${event.data.paymentIntentId ?? null}
          or charge_id=${event.data.chargeId ?? null}
        )
      order by updated_at desc limit 1`;
    const merchantId = event.data.merchantId ?? reference?.merchant_id;
    const paymentId = event.data.paymentId ?? reference?.payment_id ?? undefined;
    if (!merchantId || !paymentId) throw new RetryableWebhookError('Provider event cannot yet be correlated to an internal payment');
    return {
      ...event,
      type: event.type,
      data: {
        ...event.data,
        merchantId,
        paymentId,
        attemptId: event.data.attemptId ?? reference?.payment_attempt_id ?? undefined,
        refundId: event.data.refundId ?? reference?.refund_id ?? undefined,
      },
    };
  }

  private operationFor(type: InternalProviderEventType): string | null {
    if (type === 'payment.authorized' || type === 'payment.authorization_failed') return 'AUTHORIZE';
    if (type === 'payment.capture_succeeded' || type === 'payment.capture_failed') return 'CAPTURE';
    if (type === 'payment.cancelled') return 'VOID';
    if (type === 'refund.succeeded' || type === 'refund.failed') return 'REFUND';
    return null;
  }

  private async syncProviderMirror(tx: DbTransaction, event: CorrelatedProviderEvent): Promise<void> {
    await tx`
      update provider_transactions set
        status=${event.data.providerStatus ?? event.type},
        payment_intent_id=coalesce(${event.data.paymentIntentId ?? null}, payment_intent_id),
        charge_id=coalesce(${event.data.chargeId ?? null}, charge_id),
        last_synced_at=now(), updated_at=now()
      where provider='STRIPE' and (
        payment_attempt_id=${event.data.attemptId ?? null}
        or refund_id=${event.data.refundId ?? null}
        or provider_transaction_id=${event.data.providerTransactionId}
      )`;
  }

  private async authorizationSucceeded(tx: DbTransaction, event: CorrelatedProviderEvent): Promise<void> {
    if (!event.data.attemptId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Authorization event has no attempt id', 409);
    const attempt = await this.lockAttempt(tx, event, event.data.attemptId);
    if (attempt.status === 'SUCCEEDED') return;
    const payment = await this.lockPayment(tx, event);
    if (Number(attempt.amount) !== event.data.amount || Number(payment.amount) !== event.data.amount) throw new DomainError('PROVIDER_AMOUNT_MISMATCH', 'Provider authorization amount does not match internal intent', 409);
    const status = PaymentStateMachine.authorized(payment.status);
    await tx`update payment_attempts set status='SUCCEEDED', provider_transaction_id=${event.data.providerTransactionId}, updated_at=now() where id=${event.data.attemptId}`;
    await tx`update payments set status=${status}, authorized_amount=${event.data.amount}, authorized_at=now(), version=version+1, updated_at=now() where id=${payment.id}`;
    await this.audit.append(tx, { merchantId: payment.merchant_id, actor: { type: 'PROVIDER', id: event.data.providerTransactionId }, action: 'payment.authorized', targetType: 'payment', targetId: payment.id, metadata: { amount: event.data.amount } });
    if (payment.capture_method === 'AUTOMATIC') {
      const captureAttemptId = randomUUID();
      await tx`insert into payment_attempts (id, merchant_id, payment_id, kind, amount, currency) values (${captureAttemptId}, ${payment.merchant_id}, ${payment.id}, 'CAPTURE', ${event.data.amount}, ${event.data.currency})`;
      await tx`update payments set status='CAPTURE_PENDING', version=version+1, updated_at=now() where id=${payment.id}`;
      await this.outbox.add(tx, { aggregateType: 'PAYMENT_ATTEMPT', aggregateId: captureAttemptId, eventType: 'provider.capture.requested', payload: { merchantId: payment.merchant_id, paymentId: payment.id, attemptId: captureAttemptId, amount: event.data.amount, currency: event.data.currency, providerPaymentId: event.data.paymentIntentId ?? event.data.providerTransactionId, finalCapture: true, idempotencyKey: `capture:${captureAttemptId}` } });
    }
  }

  private async authorizationFailed(tx: DbTransaction, event: CorrelatedProviderEvent): Promise<void> {
    const payment = await this.lockPayment(tx, event); const status = PaymentStateMachine.authorizationFailed(payment.status);
    if (event.data.attemptId) await tx`update payment_attempts set status='FAILED', provider_transaction_id=${event.data.providerTransactionId}, failure_code='DECLINED', updated_at=now() where id=${event.data.attemptId}`;
    await tx`update payments set status=${status}, version=version+1, updated_at=now() where id=${payment.id}`;
  }

  private async captureSucceeded(tx: DbTransaction, event: CorrelatedProviderEvent): Promise<void> {
    if (!event.data.attemptId) throw new DomainError('INVALID_PROVIDER_EVENT', 'Capture event has no attempt id', 409);
    const attempt = await this.lockAttempt(tx, event, event.data.attemptId);
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

  private async captureFailed(tx: DbTransaction, event: CorrelatedProviderEvent): Promise<void> {
    const payment = await this.lockPayment(tx, event);
    if (event.data.attemptId) await tx`update payment_attempts set status='FAILED', provider_transaction_id=${event.data.providerTransactionId}, failure_code='PROVIDER_FAILED', updated_at=now() where id=${event.data.attemptId}`;
    await tx`update payments set status=${PaymentStateMachine.captureFailed(payment.status, Number(payment.captured_amount))}, version=version+1, updated_at=now() where id=${payment.id}`;
  }

  private async cancelled(tx: DbTransaction, event: CorrelatedProviderEvent): Promise<void> {
    const payment = await this.lockPayment(tx, event);
    if (event.data.attemptId) await tx`update payment_attempts set status='SUCCEEDED', provider_transaction_id=${event.data.providerTransactionId}, updated_at=now() where id=${event.data.attemptId}`;
    if (payment.status !== 'CANCELLED') await tx`update payments set status=${PaymentStateMachine.cancelled(payment.status)}, version=version+1, updated_at=now() where id=${payment.id}`;
  }

  private async lockPayment(tx: DbTransaction, event: CorrelatedProviderEvent): Promise<WebhookPayment> {
    const [payment] = await tx<WebhookPayment[]>`select id, merchant_id, status, capture_method, amount::text, authorized_amount::text, captured_amount::text, refunded_amount::text, platform_fee_amount::text, currency from payments where id=${event.data.paymentId} and merchant_id=${event.data.merchantId} for update`;
    if (!payment) throw new RetryableWebhookError('Payment is not visible yet');
    return payment;
  }

  private async lockAttempt(tx: DbTransaction, event: CorrelatedProviderEvent, attemptId: string): Promise<WebhookAttempt> {
    const [attempt] = await tx<WebhookAttempt[]>`
      select status, amount::text, merchant_id, payment_id, currency, provider_transaction_id
      from payment_attempts where id=${attemptId} for update`;
    if (!attempt) throw new RetryableWebhookError('Payment attempt is not visible yet');
    if (attempt.merchant_id !== event.data.merchantId || attempt.payment_id !== event.data.paymentId || attempt.currency !== event.data.currency) {
      throw new DomainError('PROVIDER_IDENTITY_MISMATCH', 'Provider event identity does not match the payment attempt', 409);
    }
    const paymentIntentId = event.data.paymentIntentId ?? event.data.providerTransactionId;
    if (attempt.provider_transaction_id && attempt.provider_transaction_id !== paymentIntentId) {
      throw new DomainError('PROVIDER_REFERENCE_MISMATCH', 'Provider event reference does not match the payment attempt', 409);
    }
    return attempt;
  }
}
