import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import {
  PaymentProvider,
  PermanentProviderError,
  ProviderOperationInput,
  ProviderResult,
  ProviderStatus,
  ProviderStatusQuery,
  RetryableProviderError,
  STRIPE_CLIENT,
  UnknownProviderOutcomeError,
} from './payment-provider.types';

@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  constructor(@Inject(STRIPE_CLIENT) private readonly stripe: Stripe) {}

  async authorize(input: ProviderOperationInput): Promise<ProviderResult> {
    if (!input.paymentMethodToken || !input.attemptId) throw new PermanentProviderError('Stripe authorization requires a payment method and attempt id');
    try {
      const intent = await this.stripe.paymentIntents.create({
        amount: input.amount,
        currency: input.currency.toLowerCase(),
        payment_method: input.paymentMethodToken,
        payment_method_types: ['card'],
        capture_method: 'manual',
        confirm: true,
        metadata: { merchantId: input.merchantId, paymentId: input.paymentId, authorizeAttemptId: input.attemptId },
      }, { idempotencyKey: input.idempotencyKey });
      return this.paymentIntentResult(intent);
    } catch (error) {
      return this.rethrow(error);
    }
  }

  async capture(input: ProviderOperationInput): Promise<ProviderResult> {
    if (!input.providerPaymentId || !input.attemptId) throw new PermanentProviderError('Stripe capture requires a PaymentIntent and attempt id');
    try {
      const intent = await this.stripe.paymentIntents.capture(input.providerPaymentId, {
        amount_to_capture: input.amount,
        final_capture: input.finalCapture ?? true,
        metadata: {
          merchantId: input.merchantId,
          paymentId: input.paymentId,
          captureAttemptId: input.attemptId,
          captureAmount: String(input.amount),
          currency: input.currency,
        },
      }, { idempotencyKey: input.idempotencyKey });
      return this.paymentIntentResult(intent);
    } catch (error) {
      return this.rethrow(error);
    }
  }

  async cancel(input: ProviderOperationInput): Promise<ProviderResult> {
    if (!input.providerPaymentId) throw new PermanentProviderError('Stripe cancellation requires a PaymentIntent');
    try {
      const intent = await this.stripe.paymentIntents.cancel(input.providerPaymentId, {
        cancellation_reason: 'requested_by_customer',
      }, { idempotencyKey: input.idempotencyKey });
      return this.paymentIntentResult(intent);
    } catch (error) {
      return this.rethrow(error);
    }
  }

  async refund(input: ProviderOperationInput): Promise<ProviderResult> {
    if (!input.providerPaymentId || !input.refundId) throw new PermanentProviderError('Stripe refund requires a PaymentIntent and refund id');
    try {
      const refund = await this.stripe.refunds.create({
        payment_intent: input.providerPaymentId,
        amount: input.amount,
        metadata: { merchantId: input.merchantId, paymentId: input.paymentId, refundId: input.refundId },
      }, { idempotencyKey: input.idempotencyKey });
      return this.refundResult(refund);
    } catch (error) {
      return this.rethrow(error);
    }
  }

  async fetchStatus(query: ProviderStatusQuery): Promise<ProviderStatus | null> {
    try {
      if (query.objectType === 'REFUND') return this.refundStatus(await this.stripe.refunds.retrieve(query.providerObjectId));
      return this.paymentIntentStatus(await this.stripe.paymentIntents.retrieve(query.providerObjectId));
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') return null;
      return this.rethrow(error);
    }
  }

  private paymentIntentResult(intent: Stripe.PaymentIntent): ProviderResult {
    return {
      providerObjectId: intent.id,
      paymentIntentId: intent.id,
      chargeId: this.expandableId(intent.latest_charge),
      status: intent.status,
      metadata: { livemode: intent.livemode },
    };
  }

  private refundResult(refund: Stripe.Refund): ProviderResult {
    return {
      providerObjectId: refund.id,
      paymentIntentId: this.expandableId(refund.payment_intent),
      chargeId: this.expandableId(refund.charge),
      status: refund.status ?? 'unknown',
      metadata: {},
    };
  }

  private paymentIntentStatus(intent: Stripe.PaymentIntent): ProviderStatus {
    return {
      ...this.paymentIntentResult(intent),
      amount: intent.amount,
      capturedAmount: intent.amount_received,
      currency: intent.currency.toUpperCase(),
    };
  }

  private refundStatus(refund: Stripe.Refund): ProviderStatus {
    return {
      ...this.refundResult(refund),
      amount: refund.amount,
      currency: refund.currency.toUpperCase(),
    };
  }

  private expandableId(value: string | { id: string } | null): string | undefined {
    if (typeof value === 'string') return value;
    return value?.id;
  }

  private rethrow(error: unknown): never {
    if (error instanceof Stripe.errors.StripeConnectionError) throw new UnknownProviderOutcomeError(error.message);
    if (error instanceof Stripe.errors.StripeAPIError || error instanceof Stripe.errors.StripeRateLimitError) throw new RetryableProviderError(error.message);
    if (error instanceof Stripe.errors.StripeError) throw new PermanentProviderError(error.message);
    throw error;
  }
}
