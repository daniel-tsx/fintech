import Stripe from 'stripe';
import { StripePaymentProvider } from '../../src/payment-provider/stripe-payment.provider';
import { UnknownProviderOutcomeError } from '../../src/payment-provider/payment-provider.types';

describe('StripePaymentProvider', () => {
  const input = {
    merchantId: 'merchant-1',
    paymentId: 'payment-1',
    attemptId: 'attempt-1',
    amount: 4_200,
    currency: 'USD',
    providerPaymentId: 'pi_123',
    finalCapture: true,
    idempotencyKey: 'capture:attempt-1',
  };

  it('maps capture to PaymentIntent.capture and preserves the stable idempotency key', async () => {
    const capture = jest.fn().mockResolvedValue(paymentIntent());
    const provider = new StripePaymentProvider(stripeWithCapture(capture));

    await expect(provider.capture(input)).resolves.toMatchObject({
      providerObjectId: 'pi_123',
      paymentIntentId: 'pi_123',
      chargeId: 'ch_123',
      status: 'succeeded',
    });
    expect(capture).toHaveBeenCalledWith('pi_123', {
      amount_to_capture: 4_200,
      final_capture: true,
      metadata: {
        merchantId: 'merchant-1',
        paymentId: 'payment-1',
        captureAttemptId: 'attempt-1',
        captureAmount: '4200',
        currency: 'USD',
      },
    }, { idempotencyKey: 'capture:attempt-1' });

    await provider.capture(input);
    expect(capture).toHaveBeenLastCalledWith('pi_123', expect.objectContaining({ amount_to_capture: 4_200 }), { idempotencyKey: 'capture:attempt-1' });
  });

  it('treats a connection timeout as an unknown outcome', async () => {
    const error = new Stripe.errors.StripeConnectionError({ message: 'socket closed' });
    const provider = new StripePaymentProvider(stripeWithCapture(jest.fn().mockRejectedValue(error)));
    await expect(provider.capture(input)).rejects.toBeInstanceOf(UnknownProviderOutcomeError);
  });
});

function stripeWithCapture(capture: jest.Mock): Stripe {
  return { paymentIntents: { capture } } as unknown as Stripe;
}

function paymentIntent(): Stripe.PaymentIntent {
  return {
    id: 'pi_123',
    object: 'payment_intent',
    amount: 4_200,
    amount_received: 4_200,
    currency: 'usd',
    latest_charge: 'ch_123',
    livemode: false,
    metadata: {},
    status: 'succeeded',
  } as unknown as Stripe.PaymentIntent;
}
