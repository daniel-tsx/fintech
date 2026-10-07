import { Module } from '@nestjs/common';
import { PaymentProviderModule } from '../payment-provider/payment-provider.module';
import { RabbitMqModule } from '../rabbitmq/rabbitmq.module';
import { PaymentCommandConsumer } from './payment-command.consumer';
import { PaymentCommandHandlerService } from './payment-command-handler.service';

@Module({
  imports: [PaymentProviderModule, RabbitMqModule],
  providers: [PaymentCommandConsumer, PaymentCommandHandlerService],
  exports: [PaymentCommandConsumer, PaymentCommandHandlerService],
})
export class PaymentCommandModule {}
