import { Module } from '@nestjs/common';
import amqp from 'amqplib';
import { AMQP_CONNECT, RabbitMqService } from './rabbitmq.service';
import { COMMAND_BROKER } from './rabbitmq.types';

@Module({
  providers: [
    { provide: AMQP_CONNECT, useValue: amqp.connect.bind(amqp) },
    RabbitMqService,
    { provide: COMMAND_BROKER, useExisting: RabbitMqService },
  ],
  exports: [COMMAND_BROKER, RabbitMqService],
})
export class RabbitMqModule {}
