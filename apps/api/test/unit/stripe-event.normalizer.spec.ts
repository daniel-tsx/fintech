import Stripe from 'stripe';
import { normalizeStripeEvent } from '../../src/webhooks/stripe-event.normalizer';

describe('normalizeStripeEvent', () => {
  it('maps an authorized PaymentIntent without leaking Stripe event names', () => {
    const event = stripeEvent('payment_intent.amount_capturable_updated', paymentIntent({
      status: 'requires_capture', amount_capturable: 5_000,
      metadata: { merchantId: 'merchant-1', paymentId: 'payment-1', authorizeAttemptId: 'attempt-auth' },
    }));
    expect(normalizeStripeEvent(event)).toMatchObject({
      type: 'payment.authorized',
      externalType: 'payment_intent.amount_capturable_updated',
      data: { attemptId: 'attempt-auth', amount: 5_000, currency: 'USD', paymentIntentId: 'pi_123' },
    });
  });

  it('maps a successful capture using the internal capture amount metadata', () => {
    const event = stripeEvent('payment_intent.succeeded', paymentIntent({
      status: 'succeeded', amount_received: 5_000,
      metadata: { merchantId: 'merchant-1', paymentId: 'payment-1', captureAttemptId: 'attempt-capture', captureAmount: '2000' },
    }));
    expect(normalizeStripeEvent(event)).toMatchObject({ type: 'payment.capture_succeeded', data: { attemptId: 'attempt-capture', amount: 2_000 } });
  });

  it('retains unsupported Stripe events explicitly as ignored provider events', () => {
    expect(normalizeStripeEvent(stripeEvent('customer.created', { id: 'cus_123' }))).toMatchObject({
      type: 'provider.unsupported', externalType: 'customer.created', data: null,
    });
  });
});

function stripeEvent(type: string, object: unknown): Stripe.Event {
  return { id: 'evt_123', object: 'event', created: 1_700_000_000, type, data: { object } } as unknown as Stripe.Event;
}

function paymentIntent(overrides: Record<string, unknown>): Stripe.PaymentIntent {
  return {
    id: 'pi_123', object: 'payment_intent', amount: 5_000, amount_capturable: 0, amount_received: 0,
    currency: 'usd', latest_charge: 'ch_123', livemode: false, metadata: {}, status: 'requires_capture', ...overrides,
  } as unknown as Stripe.PaymentIntent;
}
