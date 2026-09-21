import type { DatabaseService } from '../../src/database/database.service';
import { OutboxRelayService } from '../../src/outbox/outbox-relay.service';
import type { CommandBroker, ProviderCommandEnvelope } from '../../src/rabbitmq/rabbitmq.types';

describe('OutboxRelayService', () => {
  it('publishes the provider command with the outbox id and marks it PUBLISHED only after broker confirmation', async () => {
    const steps: string[] = [];
    const published: ProviderCommandEnvelope[] = [];
    const fixture = databaseFixture([event()], { onPublished: () => steps.push('published') });
    const broker = commandBroker((message) => { published.push(message); steps.push('confirmed'); return Promise.resolve(); });
    const relay = new OutboxRelayService(fixture.database, broker);

    await expect(relay.drain(1)).resolves.toBe(1);

    expect(published[0]).toMatchObject({
      id: 'outbox-1',
      eventType: 'provider.capture.requested',
      aggregateId: 'attempt-1',
      correlationId: 'attempt-1',
      payload: { idempotencyKey: 'capture:attempt-1' },
    });
    expect(steps).toEqual(['confirmed', 'published']);
  });

  it('leaves the outbox row retryable when RabbitMQ publication fails', async () => {
    const fixture = databaseFixture([event()]);
    const broker = commandBroker(() => Promise.reject(new Error('RabbitMQ unavailable')));
    const relay = new OutboxRelayService(fixture.database, broker);

    await expect(relay.drain(1)).resolves.toBe(0);

    expect(fixture.queries.some((query) => query.includes("set status='PENDING'"))).toBe(true);
    expect(fixture.queries.some((query) => query.includes("set status='PUBLISHED'"))).toBe(false);
  });

  it('can publish the same message id again when confirmation succeeded but the PUBLISHED update did not commit', async () => {
    const sameEvent = event();
    const fixture = databaseFixture([sameEvent, sameEvent], { failFirstPublishedUpdate: true });
    const published: ProviderCommandEnvelope[] = [];
    const relay = new OutboxRelayService(fixture.database, commandBroker((message) => { published.push(message); return Promise.resolve(); }));

    await relay.drain(1);
    await relay.drain(1);

    expect(published.map((message) => message.id)).toEqual(['outbox-1', 'outbox-1']);
  });
});

function event() {
  return {
    id: 'outbox-1', event_type: 'provider.capture.requested', aggregate_id: 'attempt-1', attempts: 1,
    created_at: new Date('2026-09-21T00:00:00.000Z'), locked_at: new Date('2026-09-21T00:00:01.000Z'),
    payload: { merchantId: 'merchant-1', paymentId: 'payment-1', attemptId: 'attempt-1', amount: 4200, currency: 'USD', providerPaymentId: 'pi_123', idempotencyKey: 'capture:attempt-1' },
  };
}

function databaseFixture(rows: ReturnType<typeof event>[], options: { failFirstPublishedUpdate?: boolean; onPublished?: () => void } = {}) {
  const remaining = [...rows];
  const queries: string[] = [];
  let failedPublishedUpdate = false;
  const sql = Object.assign(jest.fn((strings: TemplateStringsArray) => {
    const query = strings.join('?');
    queries.push(query);
    if (query.includes('with candidate as')) return Promise.resolve(remaining.length > 0 ? [remaining.shift()] : []);
    if (query.includes("set status='PUBLISHED'")) {
      options.onPublished?.();
      if (options.failFirstPublishedUpdate && !failedPublishedUpdate) {
        failedPublishedUpdate = true;
        return Promise.reject(new Error('database connection lost after broker confirm'));
      }
    }
    return Promise.resolve([]);
  }), { json: (value: unknown) => value });
  return { database: { sql } as unknown as DatabaseService, queries };
}

function commandBroker(publishProviderCommand: CommandBroker['publishProviderCommand']): CommandBroker {
  return { publishProviderCommand, consumeProviderCommands: () => Promise.resolve() };
}
