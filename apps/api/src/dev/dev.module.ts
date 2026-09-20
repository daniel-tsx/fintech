import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentsModule } from '../payments/payments.module';
import { DevController } from './dev.controller';

@Module({ imports: [OutboxModule, PaymentsModule], controllers: [DevController] })
export class DevModule {}
