import { Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';
import { WebhookBusinessService } from './webhook-business.service';
import type { ProviderEvent } from './webhook.types';
import { RetryableWebhookError } from './webhook.types';

interface InboxRow { id: string; payload: ProviderEvent; attempts: number }

@Injectable()
export class WebhookProcessorService {
  private readonly logger = new Logger(WebhookProcessorService.name);
  constructor(private readonly database: DatabaseService, private readonly business: WebhookBusinessService) {}

  async drain(limit = 25): Promise<number> {
    let processed = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claim(); if (!event) break;
      try {
        await this.database.transaction(async (tx) => {
          const [locked] = await tx<InboxRow[]>`select id, payload, attempts from webhook_events where id=${event.id} for update`;
          if (!locked || locked.payload.id !== event.payload.id) throw new Error('Webhook lease lost');
          await this.business.handle(tx, locked.payload);
          const known = ['payment.authorized','payment.authorization_failed','payment.capture_succeeded','payment.capture_failed','payment.cancelled','refund.succeeded','refund.failed','dispute.opened','dispute.closed'].includes(locked.payload.type);
          await tx`update webhook_events set status=${known ? 'PROCESSED' : 'IGNORED'}, processed_at=now(), locked_at=null, updated_at=now() where id=${locked.id}`;
        });
        processed += 1;
      } catch (error) { await this.fail(event, error); }
    }
    return processed;
  }

  private async claim(): Promise<InboxRow | null> {
    const [row] = await this.database.sql<InboxRow[]>`
      with candidate as (select id from webhook_events where (status in ('PENDING','RETRY') or (status='PROCESSING' and locked_at < now()-interval '2 minutes')) and available_at<=now() order by created_at for update skip locked limit 1)
      update webhook_events w set status='PROCESSING', locked_at=now(), attempts=w.attempts+1, updated_at=now() from candidate where w.id=candidate.id returning w.id, w.payload, w.attempts`;
    return row ?? null;
  }

  private async fail(event: InboxRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown webhook error';
    const retryable = error instanceof RetryableWebhookError || !(error instanceof DomainError);
    const dead = event.attempts >= 8 || !retryable;
    const delaySeconds = Math.min(300, 2 ** event.attempts);
    await this.database.sql`update webhook_events set status=${dead ? 'DEAD' : 'RETRY'}, available_at=now()+(${delaySeconds}::text||' seconds')::interval, locked_at=null, last_error=${message}, updated_at=now() where id=${event.id}`;
    this.logger.warn({ webhookEventId: event.id, retryable, attempts: event.attempts, error: message }, 'Webhook processing failed');
  }
}
