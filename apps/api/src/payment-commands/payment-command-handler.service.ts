import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, DbTransaction } from '../database/database.service';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  ProviderOperation,
  ProviderOperationInput,
  ProviderResult,
} from '../payment-provider/payment-provider.types';
import { MalformedProviderCommandError, ProviderCommandEnvelope } from '../rabbitmq/rabbitmq.types';

@Injectable()
export class PaymentCommandHandlerService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async execute(message: ProviderCommandEnvelope): Promise<void> {
    const input = this.input(message.payload);
    const operation = this.operation(message.eventType);
    const result = operation === 'AUTHORIZE' ? await this.provider.authorize(input)
      : operation === 'CAPTURE' ? await this.provider.capture(input)
        : operation === 'REFUND' ? await this.provider.refund(input)
          : await this.provider.cancel(input);

    await this.database.transaction(async (tx) => {
      await this.storeProviderMirror(tx, input, operation, result);
      const providerPaymentId = result.paymentIntentId ?? result.providerObjectId;
      if (input.attemptId) await tx`
        update payment_attempts
        set status='PROCESSING', provider_transaction_id=${providerPaymentId}, updated_at=now()
        where id=${input.attemptId} and status='PENDING'`;
      if (input.refundId) await tx`
        update refunds
        set status='PROCESSING', provider_transaction_id=${result.providerObjectId}, updated_at=now()
        where id=${input.refundId} and status='PENDING'`;
    });
  }

  private input(payload: Record<string, unknown>): ProviderOperationInput {
    const amount = Number(payload.amount);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new MalformedProviderCommandError('Provider command amount must be a non-negative safe integer');
    return {
      merchantId: this.requiredString(payload.merchantId, 'merchantId'),
      paymentId: this.requiredString(payload.paymentId, 'paymentId'),
      attemptId: this.optionalString(payload.attemptId),
      refundId: this.optionalString(payload.refundId),
      amount,
      currency: this.requiredString(payload.currency, 'currency'),
      paymentMethodToken: this.optionalString(payload.paymentMethodToken),
      providerPaymentId: this.optionalString(payload.providerPaymentId),
      finalCapture: typeof payload.finalCapture === 'boolean' ? payload.finalCapture : undefined,
      idempotencyKey: this.requiredString(payload.idempotencyKey, 'idempotencyKey'),
    };
  }

  private operation(eventType: ProviderCommandEnvelope['eventType']): ProviderOperation {
    if (eventType === 'provider.authorization.requested') return 'AUTHORIZE';
    if (eventType === 'provider.capture.requested') return 'CAPTURE';
    if (eventType === 'provider.refund.requested') return 'REFUND';
    if (eventType === 'provider.void.requested') return 'VOID';
    throw new MalformedProviderCommandError(`Unsupported provider command ${String(eventType)}`);
  }

  private async storeProviderMirror(
    tx: DbTransaction,
    input: ProviderOperationInput,
    operation: ProviderOperation,
    result: ProviderResult,
  ): Promise<void> {
    await tx`
      insert into provider_transactions
        (merchant_id, payment_id, payment_attempt_id, refund_id, provider, provider_transaction_id, payment_intent_id, charge_id,
         provider_idempotency_key, operation, status, amount, currency, raw_response, last_synced_at)
      values
        (${input.merchantId}, ${input.paymentId}, ${input.attemptId ?? null}, ${input.refundId ?? null}, 'STRIPE', ${result.providerObjectId},
         ${result.paymentIntentId ?? null}, ${result.chargeId ?? null}, ${input.idempotencyKey}, ${operation}, ${result.status}, ${input.amount},
         ${input.currency}, ${tx.json(result.metadata)}, now())
      on conflict (provider, provider_idempotency_key) do update set
        provider_transaction_id=excluded.provider_transaction_id,
        payment_intent_id=excluded.payment_intent_id,
        charge_id=excluded.charge_id,
        status=excluded.status,
        raw_response=excluded.raw_response,
        last_synced_at=now(),
        updated_at=now()`;
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) throw new MalformedProviderCommandError(`Provider command field ${field} must be a non-empty string`);
    return value;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
