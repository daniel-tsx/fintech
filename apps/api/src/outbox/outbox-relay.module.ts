import { Module } from '@nestjs/common';
import { RabbitMqModule } from '../rabbitmq/rabbitmq.module';
import { OutboxRelayRunner } from './outbox-relay.runner';
import { OutboxRelayService } from './outbox-relay.service';

@Module({
  imports: [RabbitMqModule],
  providers: [OutboxRelayService, OutboxRelayRunner],
  exports: [OutboxRelayService],
})
export class OutboxRelayModule {}
