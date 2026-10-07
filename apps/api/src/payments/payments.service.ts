import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthActor } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import { IdempotencyService, IdempotentResult } from '../common/idempotency.service';
import { DatabaseService, DbTransaction } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { CapturePaymentDto, CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentStateMachine, PaymentStatus } from './payment-state.machine';

interface LockedPayment { id: string; merchant_id: string; status: PaymentStatus; amount: string; currency: string; authorized_amount: string; captured_amount: string; capture_method: 'MANUAL' | 'AUTOMATIC'; payment_method_token: string }

@Injectable()
export class PaymentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  create(actor: AuthActor, key: string, dto: CreatePaymentDto): Promise<IdempotentResult<Record<string, unknown>>> {
    const merchantId = this.requireMerchant(actor);
    return this.idempotency.execute({ merchantId, operation: 'payment.create', key, payload: dto, responseStatus: 202, action: async (tx) => {
      const paymentId = randomUUID();
      const initialStatus = dto.confirm ? PaymentStateMachine.authorizationRequested('CREATED') : 'CREATED';
      await tx`insert into payments (id, merchant_id, customer_id, status, capture_method, currency, amount, payment_method_token, description, metadata)
        values (${paymentId}, ${merchantId}, ${dto.customerId ?? null}, ${initialStatus}, ${dto.captureMethod}, ${dto.currency}, ${dto.amount}, ${dto.paymentMethodToken}, ${dto.description ?? null}, ${tx.json((dto.metadata ?? {}) as never)})`;
      await this.audit.append(tx, { merchantId, actor, action: 'payment.created', targetType: 'payment', targetId: paymentId, metadata: { amount: dto.amount, currency: dto.currency, captureMethod: dto.captureMethod } });
      if (dto.confirm) await this.enqueueAuthorization(tx, actor, { id: paymentId, merchant_id: merchantId, status: initialStatus, amount: String(dto.amount), currency: dto.currency, authorized_amount: '0', captured_amount: '0', capture_method: dto.captureMethod, payment_method_token: dto.paymentMethodToken });
      return { id: paymentId, status: initialStatus, amount: dto.amount, currency: dto.currency, captureMethod: dto.captureMethod };
    }});
  }

  authorize(actor: AuthActor, paymentId: string, key: string): Promise<IdempotentResult<Record<string, unknown>>> {
    const merchantId = this.requireMerchant(actor);
    return this.idempotency.execute({ merchantId, operation: `payment.authorize:${paymentId}`, key, payload: { paymentId }, responseStatus: 202, action: async (tx) => {
      const payment = await this.lockPayment(tx, merchantId, paymentId);
      const status = PaymentStateMachine.authorizationRequested(payment.status);
      await tx`update payments set status = ${status}, version = version + 1, updated_at = now() where id = ${paymentId}`;
      await this.enqueueAuthorization(tx, actor, { ...payment, status });
      return { id: paymentId, status };
    }});
  }

  capture(actor: AuthActor, paymentId: string, key: string, dto: CapturePaymentDto): Promise<IdempotentResult<Record<string, unknown>>> {
    const merchantId = this.requireMerchant(actor);
    return this.idempotency.execute({ merchantId, operation: `payment.capture:${paymentId}`, key, payload: dto, responseStatus: 202, action: async (tx) => {
      const payment = await this.lockPayment(tx, merchantId, paymentId);
      const remaining = Number(payment.authorized_amount) - Number(payment.captured_amount);
      const amount = dto.amount ?? remaining;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) throw new DomainError('CAPTURE_AMOUNT_EXCEEDS_AUTHORIZATION', 'Capture amount exceeds the remaining authorized amount', 422, { remaining });
      const status = PaymentStateMachine.captureRequested(payment.status, remaining);
      const attemptId = randomUUID();
      const providerPaymentId = await this.providerPaymentId(tx, paymentId);
      await tx`update payments set status = ${status}, version = version + 1, updated_at = now() where id = ${paymentId}`;
      await tx`insert into payment_attempts (id, merchant_id, payment_id, kind, amount, currency) values (${attemptId}, ${merchantId}, ${paymentId}, 'CAPTURE', ${amount}, ${payment.currency})`;
      await this.outbox.add(tx, { aggregateType: 'PAYMENT_ATTEMPT', aggregateId: attemptId, eventType: 'provider.capture.requested', payload: { merchantId, paymentId, attemptId, amount, currency: payment.currency, providerPaymentId, finalCapture: amount === remaining, idempotencyKey: `capture:${attemptId}` } });
      await this.audit.append(tx, { merchantId, actor, action: 'payment.capture_requested', targetType: 'payment', targetId: paymentId, metadata: { attemptId, amount } });
      return { id: paymentId, status, captureAttemptId: attemptId, amount };
    }});
  }

  cancel(actor: AuthActor, paymentId: string, key: string): Promise<IdempotentResult<Record<string, unknown>>> {
    const merchantId = this.requireMerchant(actor);
    return this.idempotency.execute({ merchantId, operation: `payment.cancel:${paymentId}`, key, payload: { paymentId }, responseStatus: 202, action: async (tx) => {
      const payment = await this.lockPayment(tx, merchantId, paymentId); const status = PaymentStateMachine.cancelled(payment.status); const attemptId = randomUUID();
      const providerPaymentId = await this.providerPaymentId(tx, paymentId);
      await tx`update payments set status=${status}, version=version+1, updated_at=now() where id=${paymentId}`;
      await tx`insert into payment_attempts (id,merchant_id,payment_id,kind,amount,currency) values (${attemptId},${merchantId},${paymentId},'VOID',0,${payment.currency})`;
      await this.outbox.add(tx, { aggregateType:'PAYMENT_ATTEMPT', aggregateId:attemptId, eventType:'provider.void.requested', payload:{ merchantId,paymentId,attemptId,amount:0,currency:payment.currency,providerPaymentId,idempotencyKey:`void:${attemptId}` } });
      await this.audit.append(tx, { merchantId, actor, action:'payment.cancel_requested', targetType:'payment', targetId:paymentId, metadata:{attemptId} });
      return { id:paymentId,status };
    }});
  }

  async list(actor: AuthActor, page: number, pageSize: number): Promise<Record<string, unknown>> {
    const merchantId = this.requireMerchant(actor);
    const offset = (page - 1) * pageSize;
    const [items, count] = await Promise.all([
      this.database.sql`select id, status, capture_method as "captureMethod", amount::text, authorized_amount::text as "authorizedAmount", captured_amount::text as "capturedAmount", refunded_amount::text as "refundedAmount", platform_fee_amount::text as "platformFeeAmount", currency, description, created_at as "createdAt", updated_at as "updatedAt" from payments where merchant_id = ${merchantId} order by created_at desc limit ${pageSize} offset ${offset}`,
      this.database.sql<{ total: string }[]>`select count(*)::text as total from payments where merchant_id = ${merchantId}`,
    ]);
    const total = Number(count[0]?.total ?? 0);
    return { data: items, pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) } };
  }

  async detail(actor: AuthActor, paymentId: string): Promise<Record<string, unknown>> {
    const merchantId = this.requireMerchant(actor);
    const [payment] = await this.database.sql`select id, status, capture_method as "captureMethod", amount::text, authorized_amount::text as "authorizedAmount", captured_amount::text as "capturedAmount", refunded_amount::text as "refundedAmount", platform_fee_amount::text as "platformFeeAmount", currency, description, metadata, created_at as "createdAt", updated_at as "updatedAt" from payments where id = ${paymentId} and merchant_id = ${merchantId}`;
    if (!payment) throw new DomainError('PAYMENT_NOT_FOUND', 'Payment was not found', 404);
    const [attempts, refunds, ledger, audit] = await Promise.all([
      this.database.sql`select id, kind, status, amount::text, currency, provider_transaction_id as "providerTransactionId", failure_code as "failureCode", created_at as "createdAt", updated_at as "updatedAt" from payment_attempts where payment_id = ${paymentId} order by created_at`,
      this.database.sql`select id, status, amount::text, currency, reason, provider_transaction_id as "providerTransactionId", created_at as "createdAt" from refunds where payment_id = ${paymentId} order by created_at`,
      this.database.sql`select t.id, t.business_type as "businessType", t.description, t.status, t.created_at as "createdAt", a.code as "accountCode", e.debit::text, e.credit::text from ledger_transactions t join ledger_entries e on e.transaction_id=t.id join ledger_accounts a on a.id=e.account_id where t.business_id = ${paymentId} or t.business_id in (select id from payment_attempts where payment_id=${paymentId}) or t.business_id in (select id from refunds where payment_id=${paymentId}) order by t.created_at, e.created_at`,
      this.database.sql`select action, actor_type as "actorType", metadata, created_at as "createdAt" from audit_logs where target_type='payment' and target_id=${paymentId} order by created_at`,
    ]);
    return { payment, attempts, refunds, ledger, timeline: audit };
  }

  private async enqueueAuthorization(tx: DbTransaction, actor: AuthActor, payment: LockedPayment): Promise<void> {
    const attemptId = randomUUID();
    await tx`insert into payment_attempts (id, merchant_id, payment_id, kind, amount, currency) values (${attemptId}, ${payment.merchant_id}, ${payment.id}, 'AUTHORIZE', ${Number(payment.amount)}, ${payment.currency})`;
    await this.outbox.add(tx, { aggregateType: 'PAYMENT_ATTEMPT', aggregateId: attemptId, eventType: 'provider.authorization.requested', payload: { merchantId: payment.merchant_id, paymentId: payment.id, attemptId, amount: Number(payment.amount), currency: payment.currency, paymentMethodToken: payment.payment_method_token, idempotencyKey: `authorize:${attemptId}` } });
    await this.audit.append(tx, { merchantId: payment.merchant_id, actor, action: 'payment.authorization_requested', targetType: 'payment', targetId: payment.id, metadata: { attemptId } });
  }

  private async lockPayment(tx: DbTransaction, merchantId: string, paymentId: string): Promise<LockedPayment> {
    const [payment] = await tx<LockedPayment[]>`select id, merchant_id, status, amount::text, currency, authorized_amount::text, captured_amount::text, capture_method, payment_method_token from payments where id = ${paymentId} and merchant_id = ${merchantId} for update`;
    if (!payment) throw new DomainError('PAYMENT_NOT_FOUND', 'Payment was not found', 404);
    return payment;
  }

  private async providerPaymentId(tx: DbTransaction, paymentId: string): Promise<string> {
    const [authorization] = await tx<{ provider_transaction_id: string }[]>`
      select provider_transaction_id from payment_attempts
      where payment_id=${paymentId} and kind='AUTHORIZE' and status='SUCCEEDED' and provider_transaction_id is not null
      order by created_at desc limit 1`;
    if (!authorization) throw new DomainError('PROVIDER_REFERENCE_MISSING', 'The authorized payment has no Stripe PaymentIntent reference', 409);
    return authorization.provider_transaction_id;
  }

  private requireMerchant(actor: AuthActor): string {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'This operation requires a merchant context', 403);
    return actor.merchantId;
  }
}
