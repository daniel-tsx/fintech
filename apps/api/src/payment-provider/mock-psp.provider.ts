import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  PaymentProvider, ProviderOperationInput, ProviderReportRow, ProviderResult,
  RetryableProviderError, UnknownProviderOutcomeError,
} from './payment-provider.types';

interface ExistingProviderTransaction { provider_transaction_id: string; status: string }

@Injectable()
export class MockPspProvider implements PaymentProvider {
  constructor(private readonly database: DatabaseService, private readonly outbox: OutboxService) {}

  authorize(input: ProviderOperationInput): Promise<ProviderResult> { return this.perform('AUTHORIZE', input); }
  capture(input: ProviderOperationInput): Promise<ProviderResult> { return this.perform('CAPTURE', input); }
  cancel(input: ProviderOperationInput): Promise<ProviderResult> { return this.perform('VOID', input); }
  refund(input: ProviderOperationInput): Promise<ProviderResult> { return this.perform('REFUND', input); }

  async fetchTransactionStatus(providerTransactionId: string): Promise<ProviderResult | null> {
    const [row] = await this.database.sql<ExistingProviderTransaction[]>`select provider_transaction_id, status from provider_transactions where provider = 'MOCK_PSP' and provider_transaction_id = ${providerTransactionId}`;
    return row ? { providerTransactionId: row.provider_transaction_id, status: row.status } : null;
  }

  async report(): Promise<ProviderReportRow[]> {
    const rows = await this.database.sql<Array<{ provider_transaction_id: string; status: string; payment_id: string | null; operation: string; amount: string; currency: string; merchant_id: string }>>`
      select provider_transaction_id, status, payment_id, operation, amount::text, currency, merchant_id from provider_transactions order by created_at`;
    return rows.map((row) => ({ providerTransactionId: row.provider_transaction_id, status: row.status, paymentId: row.payment_id, operation: row.operation, amount: Number(row.amount), currency: row.currency, merchantId: row.merchant_id }));
  }

  private async perform(operation: 'AUTHORIZE' | 'CAPTURE' | 'VOID' | 'REFUND', input: ProviderOperationInput): Promise<ProviderResult> {
    const existing = await this.database.sql<ExistingProviderTransaction[]>`select provider_transaction_id, status from provider_transactions where provider = 'MOCK_PSP' and provider_idempotency_key = ${input.idempotencyKey}`;
    if (existing[0]) return { providerTransactionId: existing[0].provider_transaction_id, status: existing[0].status };
    if (input.scenario === 'TIMEOUT_BEFORE_PROCESSING') throw new RetryableProviderError('Mock PSP timed out before processing');
    if ((input.scenario === 'TEMPORARY_500' || input.scenario === 'REFUND_RETRY_THEN_SUCCESS') && input.attemptNumber < 3) throw new RetryableProviderError('Mock PSP temporary failure');

    const providerTransactionId = `mpsp_${randomUUID().replaceAll('-', '')}`;
    const declined = operation === 'AUTHORIZE' && input.scenario === 'DECLINE';
    const status = declined ? 'DECLINED' : operation === 'VOID' ? 'VOIDED' : operation === 'REFUND' ? 'REFUNDED' : operation === 'CAPTURE' ? 'CAPTURED' : 'AUTHORIZED';
    const eventType = declined ? 'payment.authorization_failed' : operation === 'AUTHORIZE' ? 'payment.authorized' : operation === 'CAPTURE' ? 'payment.capture_succeeded' : operation === 'REFUND' ? 'refund.succeeded' : 'payment.cancelled';
    const reportedAmount = input.scenario === 'AMOUNT_MISMATCH' ? input.amount + 1 : input.amount;
    const eventId = `evt_${randomUUID().replaceAll('-', '')}`;

    await this.database.transaction(async (tx) => {
      await tx`insert into provider_transactions
        (merchant_id, payment_id, refund_id, provider_transaction_id, provider_idempotency_key, operation, status, amount, currency, raw_response)
        values (${input.merchantId}, ${input.paymentId}, ${input.refundId ?? null}, ${providerTransactionId}, ${input.idempotencyKey}, ${operation}, ${status}, ${reportedAmount}, ${input.currency}, ${tx.json({ scenario: input.scenario })})`;
      const payload = {
        id: eventId, type: eventType, createdAt: new Date().toISOString(),
        data: { merchantId: input.merchantId, paymentId: input.paymentId, attemptId: input.attemptId, refundId: input.refundId, providerTransactionId, amount: reportedAmount, currency: input.currency, status },
      };
      const delay = input.scenario === 'DELAYED_WEBHOOK' ? 15_000 : input.scenario === 'OUT_OF_ORDER_WEBHOOK' ? 3_000 : 0;
      await this.outbox.add(tx, { aggregateType: 'MOCK_PSP', aggregateId: input.paymentId, eventType: 'mock_psp.webhook', payload: { event: payload, duplicate: input.scenario === 'DUPLICATE_WEBHOOK' }, availableAt: new Date(Date.now() + delay) });
    });
    if (input.scenario === 'PROCESSED_RESPONSE_LOST') throw new UnknownProviderOutcomeError('Mock PSP processed the request but the response was lost');
    return { providerTransactionId, status };
  }
}
