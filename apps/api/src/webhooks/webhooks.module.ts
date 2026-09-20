import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DisputesModule } from '../disputes/disputes.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RefundsModule } from '../refunds/refunds.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { WebhookBusinessService } from './webhook-business.service';
import { WebhookProcessorService } from './webhook-processor.service';
import { WebhookReceiverService } from './webhook-receiver.service';
import { WebhooksController } from './webhooks.controller';

@Module({ imports: [AuditModule, DisputesModule, LedgerModule, OutboxModule, RefundsModule, SettlementsModule], controllers: [WebhooksController], providers: [WebhookReceiverService, WebhookBusinessService, WebhookProcessorService], exports: [WebhookReceiverService, WebhookProcessorService] })
export class WebhooksModule {}
