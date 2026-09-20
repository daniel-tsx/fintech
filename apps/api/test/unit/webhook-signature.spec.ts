import { ConfigService } from '@nestjs/config';
import { WebhookReceiverService } from '../../src/webhooks/webhook-receiver.service';
import type { DatabaseService } from '../../src/database/database.service';

describe('WebhookReceiverService signatures', () => {
  const receiver = new WebhookReceiverService(new ConfigService({ WEBHOOK_SECRET: 'test-secret' }), {} as DatabaseService);

  it('generates deterministic HMAC signatures', () => {
    expect(receiver.sign('{"id":"evt_1"}')).toBe(receiver.sign('{"id":"evt_1"}'));
    expect(receiver.sign('{"id":"evt_1"}')).not.toBe(receiver.sign('{"id":"evt_2"}'));
  });

  it('rejects a bad signature before touching storage', async () => {
    await expect(receiver.receive('{"id":"evt_1"}', 'bad')).rejects.toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });
});
