import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import https from 'node:https';
import { Socket } from 'node:net';
import Stripe from 'stripe';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { providerObservationHarness } from '../support/provider-observation-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

// Keep the installed SDK's real NodeHttpClient and NodeHttpClientResponse. Only
// the native HTTPS request is replaced; no Stripe endpoint is contacted.
describeDb('D02-A independent pinned Node transport review', () => {
  let h: Awaited<ReturnType<typeof providerObservationHarness>>;
  beforeAll(async () => { h = await providerObservationHarness(); }, 30000);
  afterAll(async () => { if (h) await h.close(); });
  afterEach(() => jest.restoreAllMocks());

  function wire(replies: { status: number; body: Buffer; partial?: boolean }[]) {
    let calls = 0;
    jest.spyOn(https, 'request').mockImplementation(() => {
      const reply = replies[calls++];
      const request = new EventEmitter() as EventEmitter & {
        setTimeout(): void; write(): void; end(): void;
      };
      request.setTimeout = () => undefined;
      request.write = () => undefined;
      request.end = () => {
        const response = new IncomingMessage(new Socket());
        response.statusCode = reply.status;
        response.headers = { 'request-id': `req_review_${calls}`, 'content-type': 'application/json' };
        request.emit('response', response);
        response.push(reply.body);
        if (reply.partial) setImmediate(() => response.destroy(new Error('review connection lost')));
        else { response.complete = true; response.push(null); }
      };
      process.nextTick(() => request.emit('socket', { connecting: false }));
      return request as unknown as ReturnType<typeof https.request>;
    });
    return () => calls;
  }

  it.each([200, 400])('retains complete HTTP %s bytes through the installed Node response class', async status => {
    const f = await h.accepted();
    const raw = status === 200 ? f.raw : Buffer.from(' {"error":{"type":"invalid_request_error","message":"review"}}\n');
    const calls = wire([{ status, body: raw }]);
    const producer = new TrustedProviderObservations(h.publication,
      { account: f.account, mode: 'TEST', apiKey: 'sk_test_review_fixture', maxNetworkRetries: 0 }, Stripe.createNodeHttpClient());
    const [source] = await (await producer.execute(f.message)).publish();
    const [stored] = await h.db.sql`select response_body,body_completeness,http_status from provider_observation_sources where id=${source.id}`;
    expect(stored).toEqual({ response_body: raw, body_completeness: 'COMPLETE', http_status: status });
    expect(calls()).toBe(1);
  });

  it('retains a partial native response without inventing successful completion', async () => {
    const f = await h.accepted(), raw = f.raw.subarray(0, 30);
    wire([{ status: 200, body: raw, partial: true }]);
    const producer = new TrustedProviderObservations(h.publication,
      { account: f.account, mode: 'TEST', apiKey: 'sk_test_review_fixture', maxNetworkRetries: 0 }, Stripe.createNodeHttpClient());
    const [source] = await (await producer.execute(f.message)).publish();
    const [stored] = await h.db.sql`select response_body,body_completeness from provider_observation_sources where id=${source.id}`;
    expect(stored).toEqual({ response_body: raw, body_completeness: 'PARTIAL' });
    expect(source.normalized_outcome.disposition).toBe('AWAITING_CONFIRMATION');
  });

  // Acceptance assertion deliberately stays red until the transport captures
  // responses before RequestSender decides to retry without calling toJSON().
  it('retains the original HTTP error body even when the SDK retries before JSON handling', async () => {
    const f = await h.accepted();
    const raw = Buffer.from(' {"error":{"type":"api_error","message":"review intermediate response"}}\n');
    const calls = wire([{ status: 503, body: raw }, { status: 200, body: f.raw }]);
    const producer = new TrustedProviderObservations(h.publication,
      { account: f.account, mode: 'TEST', apiKey: 'sk_test_review_fixture', maxNetworkRetries: 1 }, Stripe.createNodeHttpClient());
    const sources = await (await producer.execute(f.message)).publish();
    const stored = await h.db.sql`select response_body,body_completeness,http_status from provider_observation_sources where outbox_id=${f.outboxId} order by source_order`;
    expect(calls()).toBe(2);
    expect(sources).toHaveLength(2);
    expect(stored[1]).toEqual({ response_body: f.raw, body_completeness: 'COMPLETE', http_status: 200 });
    expect(stored[0]).toEqual({ response_body: raw, body_completeness: 'COMPLETE', http_status: 503 });
  });
});
