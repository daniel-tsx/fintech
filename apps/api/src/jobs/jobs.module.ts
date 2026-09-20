import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxDispatcherService } from '../outbox/outbox-dispatcher.service';
import { PaymentProviderModule } from '../payment-provider/payment-provider.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { CoordinationProcessor } from './coordination.processor';
import { JobSchedulerService } from './job-scheduler.service';

@Module({
  imports: [
    BullModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ connection: { url: config.getOrThrow<string>('REDIS_URL') } }) }),
    BullModule.registerQueue({ name: 'coordination' }), PaymentProviderModule, PayoutsModule, ReconciliationModule, SettlementsModule, WebhooksModule,
  ],
  providers: [CoordinationProcessor, JobSchedulerService, OutboxDispatcherService],
})
export class JobsModule {}
