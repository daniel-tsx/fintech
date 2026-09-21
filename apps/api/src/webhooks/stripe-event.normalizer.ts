import Stripe from 'stripe';
import type { InternalProviderEventType, ProviderEvent, ProviderEventData } from './webhook.types';

export function normalizeStripeEvent(event: Stripe.Event): ProviderEvent {
  const createdAt = new Date(event.created * 1_000).toISOString();
  const unsupported = (): ProviderEvent => ({ id: event.id, type: 'provider.unsupported', externalType: event.type, createdAt, data: null });

  if (event.type.startsWith('payment_intent.')) {
    const intent = event.data.object as Stripe.PaymentIntent;
    const common: ProviderEventData = {
      merchantId: metadata(intent.metadata, 'merchantId'),
      paymentId: metadata(intent.metadata, 'paymentId'),
      providerTransactionId: intent.id,
      paymentIntentId: intent.id,
      chargeId: expandableId(intent.latest_charge),
      amount: intent.amount,
      currency: intent.currency.toUpperCase(),
      providerStatus: intent.status,
    };
    if (event.type === 'payment_intent.amount_capturable_updated' && intent.status === 'requires_capture') {
      const captureAmount = safeInteger(metadata(intent.metadata, 'captureAmount'));
      const captureAttemptId = metadata(intent.metadata, 'captureAttemptId');
      if (captureAmount !== undefined && captureAttemptId) {
        return known(event, createdAt, 'payment.capture_succeeded', { ...common, attemptId: captureAttemptId, amount: captureAmount });
      }
      return known(event, createdAt, 'payment.authorized', { ...common, attemptId: metadata(intent.metadata, 'authorizeAttemptId'), amount: intent.amount_capturable });
    }
    if (event.type === 'payment_intent.payment_failed') {
      const captureAttemptId = metadata(intent.metadata, 'captureAttemptId');
      if (captureAttemptId) {
        return known(event, createdAt, 'payment.capture_failed', { ...common, attemptId: captureAttemptId, amount: safeInteger(metadata(intent.metadata, 'captureAmount')) ?? intent.amount });
      }
      return known(event, createdAt, 'payment.authorization_failed', { ...common, attemptId: metadata(intent.metadata, 'authorizeAttemptId') });
    }
    if (event.type === 'payment_intent.succeeded') {
      const captureAmount = safeInteger(metadata(intent.metadata, 'captureAmount'));
      if (captureAmount === undefined) return unsupported();
      return known(event, createdAt, 'payment.capture_succeeded', { ...common, attemptId: metadata(intent.metadata, 'captureAttemptId'), amount: captureAmount });
    }
    if (event.type === 'payment_intent.canceled') return known(event, createdAt, 'payment.cancelled', { ...common, amount: 0 });
    return unsupported();
  }

  if (event.type === 'refund.created' || event.type === 'refund.updated' || event.type === 'refund.failed') {
    const refund = event.data.object;
    const data: ProviderEventData = {
      merchantId: metadata(refund.metadata, 'merchantId'),
      paymentId: metadata(refund.metadata, 'paymentId'),
      refundId: metadata(refund.metadata, 'refundId'),
      providerTransactionId: refund.id,
      paymentIntentId: expandableId(refund.payment_intent),
      chargeId: expandableId(refund.charge),
      amount: refund.amount,
      currency: refund.currency.toUpperCase(),
      providerStatus: refund.status ?? 'unknown',
    };
    if (event.type === 'refund.failed' || refund.status === 'failed' || refund.status === 'canceled') return known(event, createdAt, 'refund.failed', data);
    if (refund.status === 'succeeded') return known(event, createdAt, 'refund.succeeded', data);
    return unsupported();
  }

  if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
    const dispute = event.data.object;
    const outcome = dispute.status === 'won' ? 'MERCHANT_WON' : dispute.status === 'lost' ? 'MERCHANT_LOST' : undefined;
    return known(event, createdAt, event.type === 'charge.dispute.created' ? 'dispute.opened' : 'dispute.closed', {
      merchantId: metadata(dispute.metadata, 'merchantId'),
      paymentId: metadata(dispute.metadata, 'paymentId'),
      providerTransactionId: dispute.id,
      paymentIntentId: expandableId(dispute.payment_intent),
      chargeId: expandableId(dispute.charge),
      providerDisputeId: dispute.id,
      amount: dispute.amount,
      currency: dispute.currency.toUpperCase(),
      providerStatus: dispute.status,
      outcome,
    });
  }

  return unsupported();
}

function known(event: Stripe.Event, createdAt: string, type: InternalProviderEventType, data: ProviderEventData): ProviderEvent {
  return { id: event.id, type, externalType: event.type, createdAt, data };
}

function metadata(value: Stripe.Metadata | null, key: string): string | undefined {
  if (!value) return undefined;
  const item = value[key];
  return item ? item : undefined;
}

function expandableId(value: string | { id: string } | null): string | undefined {
  if (typeof value === 'string') return value;
  return value?.id;
}

function safeInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
