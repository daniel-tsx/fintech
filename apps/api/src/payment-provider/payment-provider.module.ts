import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { MockPspProvider } from './mock-psp.provider';
import { PAYMENT_PROVIDER } from './payment-provider.types';

@Module({
  imports: [OutboxModule],
  providers: [MockPspProvider, { provide: PAYMENT_PROVIDER, useExisting: MockPspProvider }],
  exports: [PAYMENT_PROVIDER, MockPspProvider],
})
export class PaymentProviderModule {}
