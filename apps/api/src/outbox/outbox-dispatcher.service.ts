import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';
import { PayoutsService } from '../payouts/payouts.service';
import {
  PAYMENT_PROVIDER, PaymentProvider, ProviderOperationInput, RetryableProviderError, UnknownProviderOutcomeError,
} from '../payment-provider/payment-provider.types';
import { WebhookReceiverService } from '../webhooks/webhook-receiver.service';
import type { MockPspEvent } from '../webhooks/webhook.types';

interface OutboxRow { id: string; event_type: string; aggregate_id: string; payload: Record<string, unknown>; attempts: number }

@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  constructor(
    private readonly database: DatabaseService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly receiver: WebhookReceiverService,
    private readonly payouts: PayoutsService,
  ) {}

  async drain(limit = 25): Promise<number> {
    let processed = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claim(); if (!event) break;
      try {
        await this.dispatch(event);
        await this.database.sql`update outbox_events set status='PUBLISHED', published_at=now(), locked_at=null, updated_at=now() where id=${event.id}`;
        processed += 1;
      } catch (error) {
        if (error instanceof UnknownProviderOutcomeError) {
          await this.database.sql`update outbox_events set status='PUBLISHED', published_at=now(), locked_at=null, last_error=${error.message}, updated_at=now() where id=${event.id}`;
          processed += 1;
        } else await this.fail(event, error);
      }
    }
    return processed;
  }

  private async claim(): Promise<OutboxRow | null> {
    const [row] = await this.database.sql<OutboxRow[]>`
      with candidate as (select id from outbox_events where (status='PENDING' or (status='PROCESSING' and locked_at < now()-interval '2 minutes')) and available_at<=now() order by created_at for update skip locked limit 1)
      update outbox_events o set status='PROCESSING', locked_at=now(), attempts=o.attempts+1, updated_at=now() from candidate where o.id=candidate.id returning o.id, o.event_type, o.aggregate_id, o.payload, o.attempts`;
    return row ?? null;
  }

  private async dispatch(event: OutboxRow): Promise<void> {
    const payload = event.payload;
    if (event.event_type.startsWith('provider.')) {
      const input: ProviderOperationInput = {
        merchantId: this.requiredString(payload.merchantId, 'merchantId'), paymentId: this.requiredString(payload.paymentId, 'paymentId'),
        attemptId: this.optionalString(payload.attemptId),
        refundId: this.optionalString(payload.refundId),
        amount: Number(payload.amount), currency: this.requiredString(payload.currency, 'currency'),
        paymentMethodToken: this.optionalString(payload.paymentMethodToken),
        idempotencyKey: this.requiredString(payload.idempotencyKey, 'idempotencyKey'), scenario: this.requiredString(payload.scenario ?? 'SUCCESS', 'scenario') as ProviderOperationInput['scenario'],
        attemptNumber: event.attempts,
      };
      const result = event.event_type === 'provider.authorization.requested' ? await this.provider.authorize(input)
        : event.event_type === 'provider.capture.requested' ? await this.provider.capture(input)
          : event.event_type === 'provider.refund.requested' ? await this.provider.refund(input)
            : await this.provider.cancel(input);
      if (input.attemptId) await this.database.sql`update payment_attempts set status='PROCESSING', provider_transaction_id=${result.providerTransactionId}, updated_at=now() where id=${input.attemptId} and status='PENDING'`;
      if (input.refundId) await this.database.sql`update refunds set status='PROCESSING', provider_transaction_id=${result.providerTransactionId}, updated_at=now() where id=${input.refundId} and status='PENDING'`;
      return;
    }
    if (event.event_type === 'mock_psp.webhook') {
      const mockEvent = payload.event as MockPspEvent; const raw = JSON.stringify(mockEvent); const signature = this.receiver.sign(raw);
      await this.receiver.receive(raw, signature, { 'x-mock-delivery': 'outbox' });
      if (payload.duplicate === true) await this.receiver.receive(raw, signature, { 'x-mock-delivery': 'duplicate' });
      return;
    }
    if (event.event_type === 'payout.process') {
      await this.database.transaction((tx) => this.payouts.complete(tx, String(payload.payoutId)));
      return;
    }
    throw new DomainError('UNKNOWN_OUTBOX_EVENT', `Unknown outbox event ${event.event_type}`, 500);
  }

  private async fail(event: OutboxRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown outbox error';
    const retryable = error instanceof RetryableProviderError || !(error instanceof DomainError);
    const dead = event.attempts >= 8 || !retryable; const delaySeconds = Math.min(300, 2 ** event.attempts);
    await this.database.sql`update outbox_events set status=${dead ? 'DEAD' : 'PENDING'}, available_at=now()+(${delaySeconds}::text||' seconds')::interval, locked_at=null, last_error=${message}, updated_at=now() where id=${event.id}`;
    this.logger.warn({ outboxEventId: event.id, eventType: event.event_type, retryable, attempts: event.attempts, error: message }, 'Outbox dispatch failed');
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new DomainError('INVALID_OUTBOX_PAYLOAD', `Outbox field ${field} must be a string`, 500);
    return value;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }
}
