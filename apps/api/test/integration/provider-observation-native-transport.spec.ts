import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import https from 'node:https';
import { Socket } from 'node:net';
import Stripe from 'stripe';
import type { ObservationTransactions } from '../../src/payment-provider/provider-observation-database';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { providerObservationHarness } from '../support/provider-observation-harness';

type Reply = { status: number; body: Buffer; headers?: Record<string, string>; interruption?: 'DROP' | 'TIMEOUT' | 'CLOSE' }
  | { connection: 'ECONNREFUSED' | 'ECONNRESET' | 'ETIMEDOUT' };
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

// Keep both installed Stripe Node transport classes and RequestSender. The
// deterministic HTTPS interception never connects a socket to a provider.
describeDb('D02-A R1 native transport evidence correction', () => {
  let h: Awaited<ReturnType<typeof providerObservationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.accepted>>;
  beforeAll(async () => { h = await providerObservationHarness(); }, 30000);
  afterAll(async () => { if (h) await h.close(); });
  afterEach(() => jest.restoreAllMocks());
  const errorBody = (text: string) => Buffer.from(` {"error":{"type":"api_error","message":"${text}"}}\n`);
  const producer = (f: Fixture, retries: 0 | 1 | 2, database: ObservationTransactions = h.publication) =>
    new TrustedProviderObservations(database, { account: f.account, mode: 'TEST', apiKey: 'sk_test_native_fixture', maxNetworkRetries: retries }, Stripe.createNodeHttpClient());

  function wire(replies: Reply[]) {
    const calls: { key: string; account: string; body: string }[] = [];
    jest.spyOn(https, 'request').mockImplementation((...args) => {
      const options = args[0] as https.RequestOptions, headers = options.headers as Record<string, string>;
      const call = { key: headers['Idempotency-Key'], account: headers['Stripe-Account'], body: '' }; calls.push(call);
      const reply = replies[calls.length - 1];
      if (!reply) throw new Error('Unexpected native HTTP attempt');
      let timeout!: () => void, response: IncomingMessage | undefined;
      const request = new EventEmitter() as EventEmitter & {
        setTimeout(ms: number, callback: () => void): void; write(chunk: string): void; end(): void; destroy(error: Error): void;
      };
      request.setTimeout = (_ms, callback) => { timeout = callback; };
      request.write = chunk => { call.body += chunk; };
      request.destroy = error => { request.emit('error', error); };
      request.end = () => {
        if ('connection' in reply) {
          if (reply.connection === 'ETIMEDOUT') setImmediate(timeout);
          else setImmediate(() => request.emit('error', Object.assign(new Error('native fixture connection failure'), { code: reply.connection })));
          return;
        }
        response = new IncomingMessage(new Socket()); response.statusCode = reply.status;
        response.headers = { 'request-id': `req_native_${calls.length}`, 'content-type': 'application/json', ...reply.headers };
        request.emit('response', response); response.push(reply.body);
        if (reply.interruption === 'TIMEOUT') setImmediate(timeout);
        else if (reply.interruption) setImmediate(() => response?.destroy(reply.interruption === 'DROP' ? new Error('native fixture truncated') : undefined));
        else { response.complete = true; response.push(null); }
      };
      process.nextTick(() => request.emit('socket', { connecting: false }));
      return request as unknown as ReturnType<typeof https.request>;
    });
    return calls;
  }

  async function evidence(f: Fixture) {
    return h.db.sql<{ id: string; source_order: string; source_key: string; execution_id: string; response_body: Buffer | null;
      body_completeness: string; http_status: number | null; hash: string | null; request_headers: Record<string, string>;
      response_headers: Record<string, string>; prior_source_id: string | null; disposition: string; reason: string }[]>`
      select s.*,encode(sha256(response_body),'hex') hash,o.disposition,o.reason from provider_observation_sources s
      join provider_observation_obligations o on o.source_id=s.id where s.outbox_id=${f.outboxId} order by source_order`;
  }
  async function counts(f: Fixture) {
    return (await h.db.sql`select
      (select count(*)::int from provider_observation_sources where outbox_id=${f.outboxId}) sources,
      (select count(*)::int from provider_observation_obligations where provider_account=${f.account}) obligations,
      (select count(*)::int from provider_observation_obligations where provider_account=${f.account} and disposition='AWAITING_APPLICATION') financial,
      (select count(*)::int from provider_financial_observations where outbox_id=${f.outboxId}) projections,
      (select evidence_revision::text from capture_accounting_scopes where merchant_id=${f.merchantId} and currency='USD') scope,
      coalesce((select evidence_revision::text from receipt_intake_authority where provider_account=${f.account}),'0') intake`)[0];
  }
  async function financial(f: Fixture) {
    return (await h.db.sql`select (select to_jsonb(p) from payments p where id=${f.paymentId}) payment,
      (select to_jsonb(r) from refunds r where id=${f.operationId}) refund,
      (select md5(string_agg(to_jsonb(t)::text,'|' order by id)) from ledger_transactions t) journals,
      (select md5(string_agg(to_jsonb(t)::text,'|' order by id)) from ledger_entries t) entries,
      (select md5(string_agg(to_jsonb(t)::text,'|' order by id)) from capture_accounting_lots t) lots`)[0];
  }
  function exact(row: Awaited<ReturnType<typeof evidence>>[number], raw: Buffer, status: number, index: number) {
    expect(row).toMatchObject({ response_body: raw, body_completeness: 'COMPLETE', http_status: status,
      hash: createHash('sha256').update(raw).digest('hex') });
    expect(row.response_headers['request-id']).toBe(`req_native_${index + 1}`);
  }

  it('retains intermediate 503 then success with ordered execution-owned bytes, one financial blocker and idempotent publication', async () => {
    const f = await h.accepted(), raw = errorBody('intermediate'), before = await financial(f);
    const calls = wire([{ status: 503, body: raw }, { status: 200, body: f.raw }]);
    const pending = await producer(f, 1).execute(f.message); await pending.publish();
    const rows = await evidence(f); expect(rows).toHaveLength(2); exact(rows[0], raw, 503, 0); exact(rows[1], f.raw, 200, 1);
    expect(rows.map(r => r.source_key)).toEqual([`${pending.executionId}:1`, `${pending.executionId}:2`]);
    expect(rows.map(r => r.execution_id)).toEqual([pending.executionId, pending.executionId]);
    expect(rows.map(r => r.prior_source_id)).toEqual([null, rows[0].id]);
    expect(rows.map(r => r.disposition)).toEqual(['AWAITING_CONFIRMATION', 'AWAITING_APPLICATION']);
    expect(rows[0].reason).toBe('RETRYABLE_TRANSPORT_FAILURE');
    expect(calls.map(c => c.key)).toEqual([f.message.payload.idempotencyKey, f.message.payload.idempotencyKey]);
    expect(calls.map(c => c.account)).toEqual([f.account, f.account]); expect(calls[0].body).toBe(calls[1].body);
    const committed = await counts(f); expect(committed).toEqual({ sources: 2, obligations: 2, financial: 1, projections: 1, scope: '2', intake: '2' });
    await pending.publish(); expect(await counts(f)).toEqual(committed); expect(calls).toHaveLength(2);
    expect(await financial(f)).toEqual(before); await expect(h.read(f)).rejects.toThrow('blocked');
  });
  it('retains complete 503 bodies through SDK retry exhaustion without financial finality', async () => {
    const f = await h.accepted(), bodies = [errorBody('first'), errorBody('last')], before = await financial(f);
    const calls = wire(bodies.map(body => ({ status: 503, body })));
    await (await producer(f, 1).execute(f.message)).publish(); const rows = await evidence(f);
    rows.forEach((row, index) => { exact(row, bodies[index], 503, index); expect(row.disposition).toBe('AWAITING_CONFIRMATION'); });
    expect(await counts(f)).toEqual({ sources: 2, obligations: 2, financial: 0, projections: 0, scope: '2', intake: '2' });
    expect(calls).toHaveLength(2); await expect(h.read(f)).resolves.toHaveLength(1); expect(await financial(f)).toEqual(before);
  });
  it('preserves multiple distinct intermediate bodies before the final operation response', async () => {
    const f = await h.accepted(), bodies = [errorBody('one'), errorBody('two'), f.raw], statuses = [503, 500, 200];
    const calls = wire(bodies.map((body, i) => ({ status: statuses[i], body })));
    const pending = await producer(f, 2).execute(f.message); await pending.publish(); const rows = await evidence(f);
    expect(rows).toHaveLength(3); rows.forEach((row, i) => { exact(row, bodies[i], statuses[i], i); expect(row.source_key).toBe(`${pending.executionId}:${i + 1}`); });
    expect(new Set(rows.map(r => r.hash)).size).toBe(3); expect(new Set(calls.map(c => c.key))).toEqual(new Set([f.message.payload.idempotencyKey]));
    expect(await counts(f)).toEqual({ sources: 3, obligations: 3, financial: 1, projections: 1, scope: '3', intake: '3' });
  });
  it('retains a complete success and safe version/request headers without authorization credentials', async () => {
    const f = await h.accepted(); wire([{ status: 200, body: f.raw, headers: { 'stripe-version': 'native-version', authorization: 'fixture-secret', 'set-cookie': 'fixture-cookie' } }]);
    await (await producer(f, 0).execute(f.message)).publish(); const [row] = await evidence(f); exact(row, f.raw, 200, 0);
    expect(row.response_headers['stripe-version']).toBe('native-version'); expect(row.request_headers['stripe-version']).toBeDefined();
    expect(row.response_headers).not.toHaveProperty('authorization'); expect(row.response_headers).not.toHaveProperty('set-cookie');
    expect(row.request_headers).not.toHaveProperty('authorization');
  });
  it('records a genuinely empty complete HTTP error body separately from no HTTP response', async () => {
    const f = await h.accepted(); wire([{ status: 503, body: Buffer.alloc(0) }]);
    await (await producer(f, 0).execute(f.message)).publish(); const [row] = await evidence(f); exact(row, Buffer.alloc(0), 503, 0);
    expect(row.disposition).toBe('AWAITING_CONFIRMATION'); expect((await counts(f)).financial).toBe(0);
  });
  it.each(['ECONNREFUSED', 'ETIMEDOUT'] as const)('retains %s without HTTP as absent unknown evidence', async connection => {
    const f = await h.accepted(), calls = wire([{ connection }]); await (await producer(f, 0).execute(f.message)).publish();
    const [row] = await evidence(f); expect(row).toMatchObject({ response_body: null, body_completeness: 'ABSENT', http_status: null, hash: null, disposition: 'AWAITING_CONFIRMATION' });
    expect(calls).toHaveLength(1); expect((await counts(f)).financial).toBe(0); await expect(h.read(f)).resolves.toHaveLength(1);
  });
  it('preserves the SDK closed-socket retry and original key even with maxNetworkRetries zero', async () => {
    const f = await h.accepted(), calls = wire([{ connection: 'ECONNRESET' }, { status: 200, body: f.raw }]);
    await (await producer(f, 0).execute(f.message)).publish(); const rows = await evidence(f);
    expect(rows[0]).toMatchObject({ response_body: null, body_completeness: 'ABSENT', http_status: null }); exact(rows[1], f.raw, 200, 1);
    expect(calls).toHaveLength(2); expect(calls[0].key).toBe(calls[1].key);
  });
  it.each(['DROP', 'TIMEOUT', 'CLOSE'] as const)('retains %s body prefix and preserves native nonretryable-200 body-error handling', async interruption => {
    const f = await h.accepted(), raw = f.raw.subarray(0, 31), calls = wire([{ status: 200, body: raw, interruption }]);
    await (await producer(f, 1).execute(f.message)).publish();
    const [row] = await evidence(f); expect(row).toMatchObject({ response_body: raw, body_completeness: 'PARTIAL', http_status: 200,
      hash: createHash('sha256').update(raw).digest('hex'), disposition: 'AWAITING_CONFIRMATION' });
    expect(calls).toHaveLength(1); expect((await counts(f)).financial).toBe(0); await expect(h.read(f)).resolves.toHaveLength(1);
  });
  it('captures a partial retryable HTTP response then lets SDK status handling retry successfully', async () => {
    const f = await h.accepted(), raw = errorBody('truncated').subarray(0, 20), calls = wire([{ status: 503, body: raw, interruption: 'DROP' }, { status: 200, body: f.raw }]);
    await (await producer(f, 1).execute(f.message)).publish(); const rows = await evidence(f);
    expect(rows[0]).toMatchObject({ response_body: raw, body_completeness: 'PARTIAL', http_status: 503, disposition: 'AWAITING_CONFIRMATION' });
    exact(rows[1], f.raw, 200, 1); expect(calls).toHaveLength(2);
  });
  it.each([true, false])('preserves stripe-should-retry=%s selection while retaining the body', async retry => {
    const f = await h.accepted(), raw = errorBody('header directed'), status = retry ? 400 : 503;
    const calls = wire([{ status, body: raw, headers: { 'stripe-should-retry': String(retry) } }, ...(retry ? [{ status: 200, body: f.raw }] : [])]);
    await (await producer(f, 2).execute(f.message)).publish(); const rows = await evidence(f); exact(rows[0], raw, status, 0);
    expect(calls).toHaveLength(retry ? 2 : 1); expect(rows[0].response_headers['stripe-should-retry']).toBe(String(retry));
    expect(rows[0].disposition).toBe('AWAITING_CONFIRMATION');
  });
  it('bounds native oversized intermediate evidence and keeps subsequent response bytes distinct', async () => {
    const f = await h.accepted(), raw = Buffer.alloc(1048577, 65), calls = wire([{ status: 503, body: raw }, { status: 200, body: f.raw }]);
    await (await producer(f, 1).execute(f.message)).publish(); const rows = await evidence(f);
    expect(rows[0]).toMatchObject({ response_body: raw.subarray(0, 1048576), body_completeness: 'PARTIAL', disposition: 'AWAITING_CONFIRMATION' });
    exact(rows[1], f.raw, 200, 1); expect(calls).toHaveLength(2);
  });
  it('does not eagerly parse a malformed intermediate body before SDK retry selection', async () => {
    const f = await h.accepted(), raw = Buffer.from([0xff, 0xfe, 0x7b]), calls = wire([{ status: 503, body: raw }, { status: 200, body: f.raw }]);
    await (await producer(f, 1).execute(f.message)).publish(); const rows = await evidence(f); exact(rows[0], raw, 503, 0); exact(rows[1], f.raw, 200, 1);
    expect(rows[0].disposition).toBe('AWAITING_CONFIRMATION'); expect(calls).toHaveLength(2);
  });
  it('rolls back native retry evidence as a group and republishes retained bytes without any additional HTTPS request', async () => {
    const f = await h.accepted(), raw = errorBody('retained retry'), calls = wire([{ status: 503, body: raw }, { status: 200, body: f.raw }]); let fail = false;
    const database: ObservationTransactions = { transaction: work => h.publication.transaction(async tx => { const result = await work(tx); if (fail) throw new Error('native fixture publication rollback'); return result; }) };
    const before = await counts(f), pending = await producer(f, 1, database).execute(f.message); fail = true;
    await expect(pending.publish()).rejects.toThrow('publication rollback'); expect(await counts(f)).toEqual(before);
    fail = false; await pending.publish(); const rows = await evidence(f); exact(rows[0], raw, 503, 0); exact(rows[1], f.raw, 200, 1);
    expect(calls).toHaveLength(2); expect((await counts(f)).financial).toBe(1);
    await expect(h.observationSql`insert into provider_observation_sources(id) values(gen_random_uuid())`).rejects.toThrow('permission denied');
    await expect(h.observationSql`update provider_observation_sources set body_completeness='COMPLETE' where id=${rows[0].id}`).rejects.toThrow('permission denied');
  });
});
