import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';
import { parseMockPspEvent } from './webhook.types';

@Injectable()
export class WebhookReceiverService {
  private readonly secret: string;
  constructor(config: ConfigService, private readonly database: DatabaseService) { this.secret = config.getOrThrow<string>('WEBHOOK_SECRET'); }

  sign(raw: string): string { return createHmac('sha256', this.secret).update(raw).digest('hex'); }

  async receive(raw: string, signature: string, headers: Record<string, string | string[] | undefined> = {}): Promise<{ id: string; duplicate: boolean }> {
    const expected = this.sign(raw);
    const supplied = Buffer.from(signature ?? '', 'utf8'); const wanted = Buffer.from(expected, 'utf8');
    if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) throw new DomainError('INVALID_WEBHOOK_SIGNATURE', 'Webhook signature verification failed', 401);
    let event;
    try { event = parseMockPspEvent(JSON.parse(raw) as unknown); } catch { throw new DomainError('INVALID_WEBHOOK_PAYLOAD', 'Webhook payload failed schema validation', 400); }
    const inserted = await this.database.sql<{ id: string }[]>`
      insert into webhook_events (provider, provider_event_id, event_type, signature, payload, headers)
      values ('MOCK_PSP', ${event.id}, ${event.type}, ${signature}, ${this.database.sql.json(event as never)}, ${this.database.sql.json(headers)})
      on conflict do nothing returning id`;
    if (inserted[0]) return { id: inserted[0].id, duplicate: false };
    const [existing] = await this.database.sql<{ id: string }[]>`select id from webhook_events where provider='MOCK_PSP' and provider_event_id=${event.id}`;
    return { id: existing.id, duplicate: true };
  }
}
