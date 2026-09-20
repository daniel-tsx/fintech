import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

@Injectable()
export class JobSchedulerService implements OnModuleInit {
  constructor(@InjectQueue('coordination') private readonly queue: Queue) {}
  async onModuleInit(): Promise<void> {
    const defaults = { attempts: 3, backoff: { type: 'exponential' as const, delay: 1_000 }, removeOnComplete: 100, removeOnFail: 500 };
    await Promise.all([
      this.queue.add('outbox-poll', {}, { ...defaults, jobId: 'outbox-poll', repeat: { every: 1_000 } }),
      this.queue.add('webhook-poll', {}, { ...defaults, jobId: 'webhook-poll', repeat: { every: 1_000 } }),
      this.queue.add('settlement-poll', {}, { ...defaults, jobId: 'settlement-poll', repeat: { every: 60_000 } }),
      this.queue.add('reconciliation-poll', {}, { ...defaults, jobId: 'reconciliation-poll', repeat: { every: 300_000 } }),
    ]);
  }
}
