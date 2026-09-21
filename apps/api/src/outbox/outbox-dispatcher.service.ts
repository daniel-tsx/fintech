import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';
import { PayoutsService } from '../payouts/payouts.service';
import {
  PAYMENT_PROVIDER, PaymentProvider, PermanentProviderError, ProviderOperation, ProviderOperationInput, ProviderResult, RetryableProviderError, UnknownProviderOutcomeError,
} from '../payment-provider/payment-provider.types';

interface OutboxRow { id: string; event_type: string; aggregate_id: string; payload: Record<string, unknown>; attempts: number }

@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  constructor(
    private readonly database: DatabaseService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
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
        await this.fail(event, error);
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
        providerPaymentId: this.optionalString(payload.providerPaymentId),
        finalCapture: typeof payload.finalCapture === 'boolean' ? payload.finalCapture : undefined,
        idempotencyKey: this.requiredString(payload.idempotencyKey, 'idempotencyKey'),
      };
      const operation = this.operation(event.event_type);
      const result = operation === 'AUTHORIZE' ? await this.provider.authorize(input)
        : operation === 'CAPTURE' ? await this.provider.capture(input)
          : operation === 'REFUND' ? await this.provider.refund(input)
            : await this.provider.cancel(input);
      await this.storeProviderMirror(input, operation, result);
      const providerPaymentId = result.paymentIntentId ?? result.providerObjectId;
      if (input.attemptId) await this.database.sql`update payment_attempts set status='PROCESSING', provider_transaction_id=${providerPaymentId}, updated_at=now() where id=${input.attemptId} and status='PENDING'`;
      if (input.refundId) await this.database.sql`update refunds set status='PROCESSING', provider_transaction_id=${result.providerObjectId}, updated_at=now() where id=${input.refundId} and status='PENDING'`;
      return;
    }
    if (event.event_type === 'payout.process') {
      await this.database.transaction((tx) => this.payouts.complete(tx, String(payload.payoutId)));
      return;
    }
    throw new DomainError('UNKNOWN_OUTBOX_EVENT', `Unknown outbox event ${event.event_type}`, 500);
  }

  private operation(eventType: string): ProviderOperation {
    if (eventType === 'provider.authorization.requested') return 'AUTHORIZE';
    if (eventType === 'provider.capture.requested') return 'CAPTURE';
    if (eventType === 'provider.refund.requested') return 'REFUND';
    if (eventType === 'provider.void.requested') return 'VOID';
    throw new DomainError('UNKNOWN_PROVIDER_COMMAND', `Unknown provider command ${eventType}`, 500);
  }

  private async storeProviderMirror(input: ProviderOperationInput, operation: ProviderOperation, result: ProviderResult): Promise<void> {
    await this.database.sql`
      insert into provider_transactions
        (merchant_id, payment_id, payment_attempt_id, refund_id, provider, provider_transaction_id, payment_intent_id, charge_id,
         provider_idempotency_key, operation, status, amount, currency, raw_response, last_synced_at)
      values
        (${input.merchantId}, ${input.paymentId}, ${input.attemptId ?? null}, ${input.refundId ?? null}, 'STRIPE', ${result.providerObjectId},
         ${result.paymentIntentId ?? null}, ${result.chargeId ?? null}, ${input.idempotencyKey}, ${operation}, ${result.status}, ${input.amount},
         ${input.currency}, ${this.database.sql.json(result.metadata)}, now())
      on conflict (provider, provider_idempotency_key) do update set
        provider_transaction_id=excluded.provider_transaction_id,
        payment_intent_id=excluded.payment_intent_id,
        charge_id=excluded.charge_id,
        status=excluded.status,
        raw_response=excluded.raw_response,
        last_synced_at=now(),
        updated_at=now()`;
  }

  private async fail(event: OutboxRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown outbox error';
    const retryable = error instanceof RetryableProviderError || error instanceof UnknownProviderOutcomeError || !(error instanceof PermanentProviderError || error instanceof DomainError);
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
