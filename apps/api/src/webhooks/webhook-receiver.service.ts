import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';
import { STRIPE_CLIENT } from '../payment-provider/payment-provider.types';
import { normalizeStripeEvent } from './stripe-event.normalizer';

@Injectable()
export class WebhookReceiverService {
  private readonly webhookSecret: string;

  constructor(
    config: ConfigService,
    private readonly database: DatabaseService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
  ) {
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET', 'whsec_placeholder');
  }

  async receive(rawBody: Buffer, signature: string, headers: Record<string, string | string[] | undefined> = {}): Promise<{ id: string; duplicate: boolean }> {
    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new DomainError('INVALID_WEBHOOK_SIGNATURE', 'Stripe webhook signature verification failed', 400);
    }

    const event = normalizeStripeEvent(stripeEvent);
    const inserted = await this.database.sql<{ id: string }[]>`
      insert into webhook_events (provider, provider_event_id, event_type, signature, payload, headers)
      values ('STRIPE', ${event.id}, ${event.type}, ${signature}, ${this.database.sql.json(event as never)}, ${this.database.sql.json(headers)})
      on conflict do nothing returning id`;
    if (inserted[0]) return { id: inserted[0].id, duplicate: false };
    const [existing] = await this.database.sql<{ id: string }[]>`select id from webhook_events where provider='STRIPE' and provider_event_id=${event.id}`;
    return { id: existing.id, duplicate: true };
  }
}
