import { Injectable } from '@nestjs/common';
import type { DbTransaction } from '../database/database.service';

@Injectable()
export class OutboxService {
  async add(tx: DbTransaction, event: { aggregateType: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; availableAt?: Date }): Promise<string> {
    const [row] = await tx<{ id: string }[]>`
      insert into outbox_events (aggregate_type, aggregate_id, event_type, payload, available_at)
      values (${event.aggregateType}, ${event.aggregateId}, ${event.eventType}, ${tx.json(event.payload as never)}, ${event.availableAt ?? new Date()}) returning id`;
    return row.id;
  }
}
