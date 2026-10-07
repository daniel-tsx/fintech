import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { DatabaseService } from '../../src/database/database.service';
import { WebhookReceiverService } from '../../src/webhooks/webhook-receiver.service';

describe('WebhookReceiverService Stripe signatures', () => {
  const secret = 'whsec_test_secret';
  const stripe = new Stripe('sk_test_placeholder');
  const sql = jest.fn();
  const database = { sql } as unknown as DatabaseService;
  const receiver = new WebhookReceiverService(new ConfigService({ STRIPE_WEBHOOK_SECRET: secret }), database, stripe);

  beforeEach(() => sql.mockClear());

  it('rejects a signature for a different raw body before touching storage', async () => {
    const signed = JSON.stringify({ id: 'evt_1', object: 'event' });
    const tampered = Buffer.from(JSON.stringify({ id: 'evt_2', object: 'event' }));
    const signature = stripe.webhooks.generateTestHeaderString({ payload: signed, secret });

    await expect(receiver.receive(tampered, signature)).rejects.toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
    expect(sql).not.toHaveBeenCalled();
  });
});
