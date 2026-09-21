import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PAYMENT_PROVIDER, STRIPE_CLIENT } from './payment-provider.types';
import { StripePaymentProvider } from './stripe-payment.provider';

@Module({
  providers: [
    {
      provide: STRIPE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Stripe(config.get<string>('STRIPE_SECRET_KEY', 'sk_test_placeholder'), {
        maxNetworkRetries: 0,
        timeout: 15_000,
        appInfo: { name: 'fintech-lab-real-psp' },
      }),
    },
    StripePaymentProvider,
    { provide: PAYMENT_PROVIDER, useExisting: StripePaymentProvider },
  ],
  exports: [PAYMENT_PROVIDER, STRIPE_CLIENT, StripePaymentProvider],
})
export class PaymentProviderModule {}
