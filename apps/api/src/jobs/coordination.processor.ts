import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { OutboxDispatcherService } from '../outbox/outbox-dispatcher.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { SettlementsService } from '../settlements/settlements.service';
import { WebhookProcessorService } from '../webhooks/webhook-processor.service';

@Processor('coordination')
export class CoordinationProcessor extends WorkerHost {
  private readonly logger = new Logger(CoordinationProcessor.name);
  constructor(private readonly outbox: OutboxDispatcherService, private readonly webhooks: WebhookProcessorService, private readonly settlements: SettlementsService, private readonly reconciliation: ReconciliationService) { super(); }
  async process(job: Job): Promise<unknown> {
    if (job.name === 'outbox-poll') return this.outbox.drain();
    if (job.name === 'webhook-poll') return this.webhooks.drain();
    if (job.name === 'settlement-poll') { const generated = await this.settlements.generate(); const completed = await this.settlements.completeDue(); return { generated, completed }; }
    if (job.name === 'reconciliation-poll') return this.reconciliation.run();
    this.logger.warn({ jobId: job.id, jobName: job.name }, 'Unknown coordination job'); return null;
  }
}
