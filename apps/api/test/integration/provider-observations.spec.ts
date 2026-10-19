import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Stripe from 'stripe';
import { RestrictedObservationDatabase, type ObservationTransactions } from '../../src/payment-provider/provider-observation-database';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { providerObservationHarness, ScriptedStripeHttp } from '../support/provider-observation-harness';
import { publishCommandObservation, signedEvidence } from '../support/trusted-evidence-fixtures';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
describeDb('D02-A isolated genuine provider observations', () => {
  let h: Awaited<ReturnType<typeof providerObservationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.accepted>>;
  beforeAll(async () => { h = await providerObservationHarness(); }, 30000);
  afterAll(async () => { if (h) await h.close(); });
  const producer = (f: Fixture, transport: ScriptedStripeHttp, database: ObservationTransactions = h.publication, retries: 0 | 1 | 2 = 0, account = f.account) =>
    new TrustedProviderObservations(database, { account, mode: 'TEST', apiKey: 'sk_test_d02_fixture', maxNetworkRetries: retries }, transport);
  async function state(f: Fixture) {
    const [row] = await h.db.sql`select
      (select count(*)::int from provider_command_executions where outbox_id=${f.outboxId}) executions,
      (select count(*)::int from provider_observation_sources where outbox_id=${f.outboxId}) sources,
      (select count(*)::int from provider_observation_obligations o join provider_observation_sources s on s.id=o.source_id where s.outbox_id=${f.outboxId}) obligations,
      (select count(*)::int from provider_financial_observations where outbox_id=${f.outboxId}) projections`;
    return row;
  }
  async function financial(f: Fixture) {
    const [row] = await h.db.sql`select
      (select to_jsonb(p) from payments p where id=${f.paymentId}) payment,
      (select md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by id),'')) from ledger_transactions t) journals,
      (select md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by id),'')) from ledger_entries t) entries,
      (select md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by id),'')) from capture_accounting_lots t) lots,
      (select to_jsonb(r) from refunds r where id=${f.operationId}) refund,
      (select to_jsonb(a) from payment_attempts a where id=${f.operationId}) attempt`;
    return row;
  }
  it('retains exact success bytes, accepted authority, source lineage and a blocking obligation without financial effects', async () => {
    const f = await h.accepted(), before = await financial(f), pending = await f.producer.execute(f.message);
    const [s] = await pending.publish();
    expect(s.normalized_outcome).toMatchObject({ disposition: 'AWAITING_APPLICATION', reason: 'CONFIRMED_PROVIDER_RESULT' });
    const [stored] = await h.db.sql`select * from provider_observation_sources where id=${s.id}`;
    expect(stored.response_body).toEqual(f.raw); expect(stored.body_completeness).toBe('COMPLETE');
    expect(stored.request_headers).not.toHaveProperty('authorization'); expect(stored.source_kind).toBe('COMMAND_RESULT');
    expect(stored.execution_id).toBe(pending.executionId); expect(stored.prior_source_id).toBeNull();
    expect(stored.database_principal).toBe(h.observationRole); expect(stored.normalization_version).toBe('D02_A_V1');
    expect(await state(f)).toEqual({ executions: 1, sources: 1, obligations: 1, projections: 1 });
    expect(await financial(f)).toEqual(before); await expect(h.read(f)).rejects.toThrow('blocked');
  });
  it('retains definitive refund failure as provider evidence, without releasing reservations or changing local state', async () => {
    const f = await h.accepted(), before = await financial(f);
    const http = new ScriptedStripeHttp(() => ({ body: Buffer.from(JSON.stringify({ ...f.object, status: 'failed', failure_reason: 'lost_or_stolen_card' })) }));
    const [s] = await (await producer(f, http).execute(f.message)).publish();
    expect(s.normalized_outcome).toMatchObject({ disposition: 'AWAITING_APPLICATION', reason: 'DEFINITIVE_PROVIDER_FAILURE' });
    expect(await financial(f)).toEqual(before);
  });
  it('rolls back a post-success persistence failure and republishes retained bytes without another provider call', async () => {
    const f = await h.accepted(); let fail = false;
    const database: ObservationTransactions = { transaction: work => h.publication.transaction(async tx => { const result = await work(tx); if (fail) throw new Error('injected commit loss'); return result; }) };
    const pending = await producer(f, f.transport, database).execute(f.message); fail = true;
    await expect(pending.publish()).rejects.toThrow('injected commit loss');
    expect(await state(f)).toEqual({ executions: 1, sources: 0, obligations: 0, projections: 0 });
    fail = false; await pending.publish(); expect(f.transport.calls).toHaveLength(1);
    expect(await state(f)).toEqual({ executions: 1, sources: 1, obligations: 1, projections: 1 });
  });
  it('recovers worker interruption/redelivery with a new execution and the original provider key', async () => {
    const f = await h.accepted(); await f.producer.execute(f.message); // process loses the first response
    expect(await state(f)).toEqual({ executions: 1, sources: 0, obligations: 0, projections: 0 });
    await (await f.producer.execute(f.message)).publish();
    expect(f.transport.calls).toHaveLength(2);
    for (const call of f.transport.calls) expect(call[4]['Idempotency-Key']).toBe(f.message.payload.idempotencyKey);
    expect(await state(f)).toEqual({ executions: 2, sources: 1, obligations: 1, projections: 1 });
  });
  it('deduplicates exact source publication but retains a real later same-key replay as new evidence', async () => {
    const f = await h.accepted(), pending = await f.producer.execute(f.message);
    const first = await pending.publish(); expect(await pending.publish()).toEqual(first);
    const [second] = await (await f.producer.execute(f.message)).publish(); expect(second.id).not.toBe(first[0].id);
    const [row] = await h.db.sql`select prior_source_id from provider_observation_sources where id=${second.id}`;
    expect(row.prior_source_id).toBe(first[0].id); expect((await state(f)).sources).toBe(2);
  });
  it('preserves a conflicting later terminal result and blocks review without replacing the original', async () => {
    const f = await h.accepted(); const [first] = await (await f.producer.execute(f.message)).publish();
    const http = new ScriptedStripeHttp(() => ({ body: Buffer.from(JSON.stringify({ ...f.object, status: 'failed' })) }));
    const [later] = await (await producer(f, http).execute(f.message)).publish();
    expect(later.normalized_outcome).toMatchObject({ reason: 'CONTRADICTORY_PROVIDER_RESULT', disposition: 'BLOCKING_REVIEW' });
    expect((await h.db.sql`select response_body from provider_observation_sources where id=${first.id}`)[0].response_body).toEqual(f.raw);
    expect(await state(f)).toEqual({ executions: 2, sources: 2, obligations: 2, projections: 1 });
  });
  it.each(['id', 'aggregateId', 'eventType', 'merchantId', 'paymentId', 'amount', 'currency', 'idempotencyKey'])(
    'rejects untrusted envelope %s before the provider call', async field => {
      const f = await h.accepted(), message = structuredClone(f.message);
      if (field === 'id' || field === 'aggregateId') message[field] = randomUUID();
      else if (field === 'eventType') message.eventType = 'provider.capture.requested';
      else message.payload[field] = field === 'amount' ? 2001 : 'untrusted';
      await expect(f.producer.execute(message)).rejects.toThrow(); expect(f.transport.calls).toHaveLength(0);
      expect(await state(f)).toEqual({ executions: 0, sources: 0, obligations: 0, projections: 0 });
    });
  it('rejects wrong configured account before the provider call', async () => {
    const f = await h.accepted(); await expect(producer(f, f.transport, h.publication, 0, 'acct_other').execute(f.message)).rejects.toThrow();
    expect(f.transport.calls).toHaveLength(0);
  });
  it('retains an explicit returned account mismatch as an unscoped blocker', async () => {
    const f = await h.accepted(), http = new ScriptedStripeHttp(() => ({ body: f.raw, headers: { 'stripe-account': 'acct_wrong' } }));
    const [source] = await (await producer(f, http).execute(f.message)).publish();
    expect(source.normalized_outcome).toMatchObject({ disposition: 'BLOCKING_REVIEW', reason: 'PROVIDER_ACCOUNT_CONFLICT' });
    expect((await h.db.sql`select merchant_id from provider_observation_obligations where source_id=${source.id}`)[0].merchant_id).toBeNull();
  });
  it.each(['amount', 'currency', 'livemode', 'merchantId', 'paymentId', 'refundId', 'payment_intent', 'id'])(
    'retains contradictory actual provider %s with no authoritative projection', async field => {
      const f = await h.accepted(); const object: Record<string, unknown> = structuredClone(f.object);
      if (['merchantId', 'paymentId', 'refundId'].includes(field)) object.metadata = { ...f.object.metadata, [field]: randomUUID() };
      else object[field] = field === 'amount' ? 2001 : field === 'livemode' ? true : field === 'currency' ? 'eur' : 'wrong_object';
      const raw = Buffer.from(JSON.stringify(object)), http = new ScriptedStripeHttp(() => ({ body: raw }));
      const [s] = await (await producer(f, http).execute(f.message)).publish();
      expect(s.normalized_outcome.disposition).toBe('BLOCKING_REVIEW'); expect((await state(f)).projections).toBe(0);
      expect((await h.db.sql`select response_body from provider_observation_sources where id=${s.id}`)[0].response_body).toEqual(raw);
    });
  it('records timeout as unknown and keeps later owned lookup provenance distinct', async () => {
    const f = await h.accepted('CAPTURE'), before = await financial(f);
    const http = new ScriptedStripeHttp(() => Stripe.HttpClient.makeTimeoutError());
    const [unknown] = await (await producer(f, http).execute(f.message)).publish();
    expect(unknown.normalized_outcome).toMatchObject({ kind: 'UNKNOWN_OUTCOME', disposition: 'AWAITING_CONFIRMATION' });
    await expect(h.read(f)).resolves.toHaveLength(1);
    const [run] = await h.db.sql<{ id: string }[]>`insert into reconciliation_runs default values returning id`;
    const pending = await f.producer.lookup(f.outboxId, { objectId: f.pi, priorSourceId: unknown.id, reconciliationRunId: run.id, actor: 'isolated-reconciler' });
    const [lookup] = await pending.publish();
    const [stored] = await h.db.sql`select source_kind,prior_source_id,execution_id from provider_observation_sources where id=${lookup.id}`;
    expect(stored).toEqual({ source_kind: 'PROVIDER_LOOKUP', prior_source_id: unknown.id, execution_id: null });
    expect(lookup.normalized_outcome.reason).toBe('CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED'); expect(await financial(f)).toEqual(before);
  });
  it('refuses an unowned lookup target before issuing GET', async () => {
    const f = await h.accepted(), [s] = await (await f.producer.execute(f.message)).publish();
    const [run] = await h.db.sql<{ id: string }[]>`insert into reconciliation_runs default values returning id`;
    await expect(f.producer.lookup(f.outboxId, { objectId: 're_unowned', priorSourceId: s.id, reconciliationRunId: run.id, actor: 'fixture' })).rejects.toThrow();
    expect(f.transport.calls).toHaveLength(1);
  });
  it.each(['partial', 'oversize', 'invalid_json', 'invalid_utf8', 'http_500', 'http_429', 'resource_missing'])(
    'retains %s without guessing no effect', async kind => {
      const f = await h.accepted();
      const body = kind === 'oversize' ? Buffer.alloc(1048577, 65) : kind === 'invalid_utf8' ? Buffer.from([255, 254]) : kind === 'invalid_json' ? Buffer.from('{oops')
        : kind.startsWith('http_') || kind === 'resource_missing' ? Buffer.from('{"error":{"type":"api_error","message":"fixture","code":"resource_missing"}}') : f.raw.subarray(0, 30);
      const http = new ScriptedStripeHttp(() => ({ body, partial: kind === 'partial', status: kind === 'http_500' ? 500 : kind === 'http_429' ? 429 : kind === 'resource_missing' ? 404 : 200 }));
      const [s] = await (await producer(f, http).execute(f.message)).publish();
      expect(s.normalized_outcome.disposition).toBe('AWAITING_CONFIRMATION'); expect((await state(f)).projections).toBe(0);
      const [stored] = await h.db.sql`select response_body,body_completeness from provider_observation_sources where id=${s.id}`;
      expect(stored.response_body).toEqual(body.subarray(0, 1048576));
      expect(stored.body_completeness).toBe(['partial', 'oversize'].includes(kind) ? 'PARTIAL' : 'COMPLETE');
    });
  it('retains separate transport attempts for SDK automatic retries with the unchanged provider key', async () => {
    const f = await h.accepted(); const http = new ScriptedStripeHttp((_args, index) => index === 0
      ? { body: Buffer.from('{"error":{"type":"api_error","message":"fixture"}}'), status: 503 } : { body: f.raw });
    const sources = await (await producer(f, http, h.publication, 1).execute(f.message)).publish();
    expect(http.calls).toHaveLength(2); expect(sources).toHaveLength(2);
    expect(sources[0].normalized_outcome.disposition).toBe('AWAITING_CONFIRMATION'); expect(sources[1].normalized_outcome.disposition).toBe('AWAITING_APPLICATION');
    expect(http.calls[0][4]['Idempotency-Key']).toBe(http.calls[1][4]['Idempotency-Key']);
    const stored = await h.db.sql`select response_body,body_completeness,http_status from provider_observation_sources where outbox_id=${f.outboxId} order by source_order`;
    expect(stored).toEqual([
      { response_body: Buffer.from('{"error":{"type":"api_error","message":"fixture"}}'), body_completeness: 'COMPLETE', http_status: 503 },
      { response_body: f.raw, body_completeness: 'COMPLETE', http_status: 200 },
    ]);
  });
  it('serializes simultaneous exact publications and retains both distinct concurrent invocations', async () => {
    const f = await h.accepted(), pending = await f.producer.execute(f.message);
    const same = await Promise.all([pending.publish(), pending.publish()]); expect(same[0]).toEqual(same[1]);
    const other = producer(f, f.transport, h.peerPublication);
    const invocations = await Promise.all([f.producer.execute(f.message), other.execute(f.message)]);
    await Promise.all(invocations.map(p => p.publish()));
    expect(await state(f)).toEqual({ executions: 3, sources: 3, obligations: 3, projections: 3 });
    const sources = await h.db.sql`select prior_source_id from provider_observation_sources where outbox_id=${f.outboxId} order by source_order`;
    expect(sources.filter(s => s.prior_source_id !== null)).toHaveLength(2);
  });
  it('waits for an account reader lock then commits its blocker before the next admission read', async () => {
    const f = await h.accepted(), pending = await f.producer.execute(f.message);
    let release!: () => void, locked!: () => void;
    const holding = new Promise<void>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const reader = h.db.transaction(async tx => { await tx`select 1 from financial_evidence_accounts where provider='STRIPE' and provider_account=${f.account} for share`; locked(); await gate; });
    await holding; const publication = pending.publish();
    try {
      let waiting = false;
      for (let n = 0; n < 100 && !waiting; n++) { waiting = (await h.db.sql`select 1 from pg_stat_activity where application_name='d02_publisher' and wait_event_type='Lock'`).length > 0; if (!waiting) await delay(10); }
      expect(waiting).toBe(true);
    } finally { release(); }
    await reader; await publication; await expect(h.read(f)).rejects.toThrow('blocked');
  });
  it('rejects owner sessions and unauthorized roles, including direct table/ledger writes and acceptance', async () => {
    await expect(new RestrictedObservationDatabase(h.db.sql).transaction(async tx => tx`select 1`)).rejects.toThrow('restricted');
    await expect(h.observationSql`insert into provider_command_executions(id,outbox_id) values(${randomUUID()},${randomUUID()})`).rejects.toThrow('permission denied');
    await expect(h.observationSql`select public.accept_provider_command(${randomUUID()},'acct_other','TEST')`).rejects.toThrow('permission denied');
    await expect(h.observationSql`update ledger_transactions set description='forged'`).rejects.toThrow('permission denied');
    const acl = await h.db.sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      and c.relkind='r' and (has_table_privilege(${h.observationRole},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') or has_any_column_privilege(${h.observationRole},c.oid,'INSERT,UPDATE'))`;
    expect(acl).toHaveLength(0);
  });
  it.each(['provider_observation_sources', 'provider_observation_obligations', 'provider_command_executions', 'provider_command_authorities', 'provider_observation_projections'])(
    'rejects UPDATE, DELETE and TRUNCATE of %s even from the database owner', async table => {
      const f = await h.accepted(); await (await f.producer.execute(f.message)).publish();
      for (const statement of [`update ${table} set ${table === 'provider_observation_obligations' ? 'reason=reason' : table === 'provider_command_authorities' ? 'outbox_id=outbox_id' : table === 'provider_observation_projections' ? 'source_id=source_id' : 'id=id'}`,
        `delete from ${table}`, `truncate ${table} cascade`]) await expect(h.db.sql.unsafe(statement)).rejects.toThrow();
      expect((await state(f)).sources).toBe(1);
    });
  it('freezes accepted financial identity while allowing operational outbox bookkeeping', async () => {
    const f = await h.accepted();
    await expect(h.db.sql`update outbox_events set payload='{}'::jsonb where id=${f.outboxId}`).rejects.toThrow('immutable');
    await expect(h.db.sql`update refunds set amount=amount+1 where id=${f.operationId}`).rejects.toThrow('immutable');
    await expect(h.db.sql`update payments set currency='EUR' where id=${f.paymentId}`).rejects.toThrow('immutable');
    await h.db.sql`update outbox_events set attempts=attempts+1 where id=${f.outboxId}`;
    await (await f.producer.execute(f.message)).publish(); expect((await state(f)).sources).toBe(1);
  });
  it('rejects an incomplete source at deferred commit and rolls back the entire transaction', async () => {
    const f = await h.accepted(), [source] = await (await f.producer.execute(f.message)).publish(), id = randomUUID();
    await expect(h.db.transaction(async tx => {
      await tx`insert into provider_observation_sources overriding system value
        select (jsonb_populate_record(null::provider_observation_sources,to_jsonb(s)||jsonb_build_object('id',${id}::text,'source_order',900000000000000,'source_key',${randomUUID()}::text))).*
        from provider_observation_sources s where id=${source.id}`;
    })).rejects.toThrow('atomic admission obligation');
    expect(await h.db.sql`select 1 from provider_observation_sources where id=${id}`).toHaveLength(0);
    expect((await state(f)).sources).toBe(1);
  });
  it('does not promote committed historical commands into prospective authority', async () => {
    const f = await h.accepted();
    await expect(h.db.sql`select public.accept_provider_command(${f.refundCommandId},${f.account},'TEST')`).rejects.toThrow('prospective');
  });
  it('cannot anchor one accepted operation to a second command identity', async () => {
    const f = await h.accepted();
    await expect(h.db.sql`insert into provider_command_authorities(outbox_id,provider,provider_account,provider_mode,operation,operation_id,payment_id,merchant_id,currency,
      amount,command_key,command_payload,accounting_policy,acceptance_epoch)
      select ${f.refundCommandId},provider,provider_account,provider_mode,operation,operation_id,payment_id,merchant_id,currency,
      amount,'different-command-key',command_payload,accounting_policy,acceptance_epoch from provider_command_authorities where outbox_id=${f.outboxId}`)
      .rejects.toThrow('provider_authority_operation_unique');
  });
  it('stops expired same-key POST recovery but permits an owned lookup after a lost response', async () => {
    const f = await h.accepted('CAPTURE');
    await h.db.sql`insert into provider_command_executions(id,outbox_id,prepared_at) values(${randomUUID()},${f.outboxId},now()-interval '24 hours')`;
    await expect(f.producer.execute(f.message)).rejects.toThrow('reconciliation'); expect(f.transport.calls).toHaveLength(0);
    const [run] = await h.db.sql<{ id: string }[]>`insert into reconciliation_runs default values returning id`;
    const [source] = await (await f.producer.lookup(f.outboxId, { objectId: f.pi, priorSourceId: null, reconciliationRunId: run.id, actor: 'lost-response-reconciler' })).publish();
    expect(source.normalized_outcome.reason).toBe('CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED'); expect(f.transport.calls[0][3]).toBe('GET');
    expect(await state(f)).toEqual({ executions: 1, sources: 1, obligations: 1, projections: 0 });
  });
  it('retains a changed source-key publication as a separate blocking witness', async () => {
    const f = await h.accepted(), [first] = await (await f.producer.execute(f.message)).publish();
    const [s] = await h.db.sql<{request_method:string;request_path:string;request_host:string;request_protocol:string;request_headers:Record<string,string>;request_body:Buffer;
      response_headers:Record<string,string>;http_status:number;source_key:string;execution_id:string;observed_at:Date}[]>`select * from provider_observation_sources where id=${first.id}`;
    const context = { method: s.request_method, path: s.request_path, host: s.request_host, protocol: s.request_protocol,
      requestHeaders: s.request_headers, requestBody: s.request_body.toString('hex'), responseHeaders: s.response_headers, httpStatus: s.http_status, transportError: null };
    const [later] = await h.observationSql<{id:string;normalized_outcome:Record<string,unknown>}[]>`select * from public.publish_provider_observation(${f.outboxId},${f.account},'TEST','COMMAND_RESULT',${s.source_key},${s.execution_id},
      null,null,null,null,${h.observationSql.json(context)},${Buffer.from(JSON.stringify({ ...f.object, status: 'failed' }))},'COMPLETE','22.6.2',${s.observed_at})`;
    expect(later.normalized_outcome).toMatchObject({ disposition: 'BLOCKING_REVIEW', reason: 'SOURCE_KEY_CONFLICT' });
    expect(await state(f)).toEqual({ executions: 1, sources: 2, obligations: 2, projections: 1 });
    expect((await h.db.sql`select merchant_id from provider_observation_obligations where source_id=${later.id}`)[0].merchant_id).toBeNull();
  });
  it.each(['AUTHORIZE', 'VOID'] as const)('retains %s without manufacturing a capture projection', async operation => {
    const f = await h.accepted(operation), before = await financial(f);
    const [s] = await (await f.producer.execute(f.message)).publish();
    expect(s.normalized_outcome).toMatchObject({ reason: 'CONFIRMED_PROVIDER_RESULT', disposition: 'AWAITING_APPLICATION' });
    expect((await state(f)).projections).toBe(0); expect(await financial(f)).toEqual(before);
  });
  it('preserves signed-receipt provenance and existing R1 proof behavior after a genuine result', async () => {
    const f = await h.accepted(); await h.db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
    await (await f.producer.execute(f.message)).publish();
    const original = signedEvidence(f, { object: { id: f.object.id, amount: 2000, metadata: f.object.metadata } });
    const signed = h.sign(original.raw), receipt = await h.receiver(f.account).receive(signed.raw, signed.signature, {});
    const correlated = await h.correlate(f.account).correlate(receipt.id);
    // No allocation was manufactured for this prospective refund: the existing
    // proof recognizer must remain closed, despite a genuine successful source.
    expect(correlated).toBeDefined();
    expect((await h.db.sql`select count(*)::int n from webhook_financial_evidence where inbox_id=${receipt.id}`)[0].n).toBe(0);
    expect((await state(f)).sources).toBe(1);
  });
});
