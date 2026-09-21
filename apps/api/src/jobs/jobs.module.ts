import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalOutboxProcessorService } from '../outbox/internal-outbox-processor.service';
import { PayoutsModule } from '../payouts/payouts.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { CoordinationProcessor } from './coordination.processor';
import { JobSchedulerService } from './job-scheduler.service';

@Module({
  imports: [
    BullModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ connection: { url: config.getOrThrow<string>('REDIS_URL') } }) }),
    BullModule.registerQueue({ name: 'coordination' }), PayoutsModule, ReconciliationModule, SettlementsModule, WebhooksModule,
  ],
  providers: [CoordinationProcessor, JobSchedulerService, InternalOutboxProcessorService],
})
export class JobsModule {}
