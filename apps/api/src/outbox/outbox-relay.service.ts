import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { COMMAND_BROKER, CommandBroker, ProviderCommandEnvelope, ProviderCommandEventType } from '../rabbitmq/rabbitmq.types';

interface RelayRow {
  id: string;
  event_type: ProviderCommandEventType;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date | string;
  locked_at: Date;
}

@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  constructor(
    private readonly database: DatabaseService,
    @Inject(COMMAND_BROKER) private readonly broker: CommandBroker,
  ) {}

  async drain(limit = 25): Promise<number> {
    let published = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claim();
      if (!event) break;
      try {
        await this.broker.publishProviderCommand(this.envelope(event));
        await this.database.sql`
          update outbox_events
          set status='PUBLISHED', published_at=now(), locked_at=null, updated_at=now()
          where id=${event.id} and status='PROCESSING' and locked_at=${event.locked_at}`;
        published += 1;
      } catch (error) {
        await this.releaseForRetry(event, error);
      }
    }
    return published;
  }

  private async claim(): Promise<RelayRow | null> {
    const [row] = await this.database.sql<RelayRow[]>`
      with candidate as (
        select id from outbox_events
        where event_type in ('provider.authorization.requested','provider.capture.requested','provider.refund.requested','provider.void.requested')
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
      returning o.id, o.event_type, o.aggregate_id, o.payload, o.attempts, o.created_at, o.locked_at`;
    return row ?? null;
  }

  private envelope(event: RelayRow): ProviderCommandEnvelope {
    const correlationId = this.optionalString(event.payload.correlationId)
      ?? this.optionalString(event.payload.attemptId)
      ?? this.optionalString(event.payload.refundId)
      ?? this.optionalString(event.payload.paymentId)
      ?? event.aggregate_id;
    return {
      id: event.id,
      eventType: event.event_type,
      aggregateId: event.aggregate_id,
      payload: event.payload,
      createdAt: new Date(event.created_at).toISOString(),
      correlationId,
    };
  }

  private async releaseForRetry(event: RelayRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown broker publication error';
    const delaySeconds = Math.min(300, 2 ** Math.min(event.attempts, 8));
    await this.database.sql`
      update outbox_events
      set status='PENDING', available_at=now()+(${delaySeconds}::text||' seconds')::interval,
          locked_at=null, last_error=${message}, updated_at=now()
      where id=${event.id} and status='PROCESSING' and locked_at=${event.locked_at}`;
    this.logger.warn({ outboxEventId: event.id, attempts: event.attempts, error: message }, 'RabbitMQ publication failed; outbox row remains retryable');
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
