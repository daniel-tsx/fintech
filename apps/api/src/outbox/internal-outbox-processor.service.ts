import { Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';
import { PayoutsService } from '../payouts/payouts.service';

interface InternalOutboxRow {
  id: string;
  event_type: 'payout.process';
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class InternalOutboxProcessorService {
  private readonly logger = new Logger(InternalOutboxProcessorService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly payouts: PayoutsService,
  ) {}

  async drain(limit = 25): Promise<number> {
    let processed = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claim();
      if (!event) break;
      try {
        await this.database.transaction((tx) => this.payouts.complete(tx, this.requiredString(event.payload.payoutId, 'payoutId')));
        await this.database.sql`update outbox_events set status='PUBLISHED', published_at=now(), locked_at=null, updated_at=now() where id=${event.id}`;
        processed += 1;
      } catch (error) {
        await this.fail(event, error);
      }
    }
    return processed;
  }

  private async claim(): Promise<InternalOutboxRow | null> {
    const [row] = await this.database.sql<InternalOutboxRow[]>`
      with candidate as (
        select id from outbox_events
        where event_type='payout.process'
          and (status='PENDING' or (status='PROCESSING' and locked_at < now()-interval '2 minutes'))
          and available_at<=now()
        order by created_at
        for update skip locked
        limit 1
      )
      update outbox_events o
      set status='PROCESSING', locked_at=now(), attempts=o.attempts+1, updated_at=now()
      from candidate
      where o.id=candidate.id
      returning o.id, o.event_type, o.payload, o.attempts`;
    return row ?? null;
  }

  private async fail(event: InternalOutboxRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown internal outbox error';
    const retryable = !(error instanceof DomainError);
    const dead = event.attempts >= 8 || !retryable;
    const delaySeconds = Math.min(300, 2 ** event.attempts);
    await this.database.sql`
      update outbox_events
      set status=${dead ? 'DEAD' : 'PENDING'}, available_at=now()+(${delaySeconds}::text||' seconds')::interval,
          locked_at=null, last_error=${message}, updated_at=now()
      where id=${event.id}`;
    this.logger.warn({ outboxEventId: event.id, attempts: event.attempts, retryable, error: message }, 'Internal outbox processing failed');
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new DomainError('INVALID_OUTBOX_PAYLOAD', `Outbox field ${field} must be a string`, 500);
    return value;
  }
}
