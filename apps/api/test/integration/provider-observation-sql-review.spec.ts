import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres, { type Sql } from 'postgres';
import Stripe from 'stripe';
import type { ObservationTransactions } from '../../src/payment-provider/provider-observation-database';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { RestrictedReceiptDatabase } from '../../src/webhooks/trusted-receipt-database';
import { TrustedSignedReceiptService } from '../../src/webhooks/trusted-signed-receipt.service';
import { providerObservationHarness, ScriptedStripeHttp } from '../support/provider-observation-harness';
import { signedEvidence } from '../support/trusted-evidence-fixtures';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(15000);

describeDb('D02-A independent SQL atomicity and controlled schedules', () => {
  let h: Awaited<ReturnType<typeof providerObservationHarness>>;
  let receiptSql: Sql, receiptDatabase: RestrictedReceiptDatabase;
  type Fixture = Awaited<ReturnType<typeof h.accepted>>;
  beforeAll(async () => {
    h = await providerObservationHarness();
    const role = `d02_review_receipt_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
    await h.db.sql.unsafe(`create role "${role}" login password '${password}' noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await h.db.sql.unsafe(`grant usage on schema public to "${role}"`);
    await h.db.sql.unsafe(`grant insert(provider,provider_event_id,event_type,signature,payload,headers),select(id,provider,provider_event_id) on public.webhook_events to "${role}"`);
    await h.db.sql.unsafe(`grant select(inbox_id) on public.provider_financial_receipts,public.receipt_admissions to "${role}"`);
    await h.db.sql.unsafe(`grant execute on function public.publish_admitted_receipt(uuid,text,bytea,text),public.publish_verified_receipt_delivery(uuid,text,bytea,text,jsonb,jsonb,text) to "${role}"`);
    const url = new URL(process.env.MIGRATION_ADMIN_URL!);
    url.pathname = '/' + (await h.db.sql`select current_database() name`)[0].name;
    url.username = role; url.password = password;
    receiptSql = postgres(url.toString(), { max: 1, connection: { application_name: 'd02_review_receipt', statement_timeout: 10000 } });
    receiptDatabase = new RestrictedReceiptDatabase(receiptSql, 'PUBLISHER');
  }, 30000);
  afterAll(async () => { if (receiptSql) await receiptSql.end(); if (h) await h.close(); });
  const producer = (f: Fixture, database: ObservationTransactions = h.publication, raw = f.raw) =>
    new TrustedProviderObservations(database, { account: f.account, mode: 'TEST', apiKey: 'sk_test_review_fixture', maxNetworkRetries: 0 },
      new ScriptedStripeHttp(() => ({ body: raw })));
  async function snapshot(f: Fixture) {
    return (await h.db.sql`select
      (select count(*)::int from provider_observation_sources where outbox_id=${f.outboxId}) sources,
      (select count(*)::int from provider_observation_obligations where provider_account=${f.account}) obligations,
      (select count(*)::int from provider_financial_observations where outbox_id=${f.outboxId}) projections,
      (select evidence_revision::text from capture_accounting_scopes where merchant_id=${f.merchantId} and currency='USD') scope,
      coalesce((select evidence_revision::text from receipt_intake_authority where provider_account=${f.account}),'0') intake`)[0];
  }

  it.each(['AUTHORIZE', 'CAPTURE', 'REFUND', 'VOID'] as const)('rejects a forged %s command before transport', async operation => {
    const f = await h.accepted(operation), command = structuredClone(f.message);
    command.payload.amount = 9999;
    await expect(f.producer.execute(command)).rejects.toThrow();
    expect(f.transport.calls).toHaveLength(0);
    expect(await h.db.sql`select id from provider_command_executions where outbox_id=${f.outboxId}`).toHaveLength(0);
  });

  it.each(['pending', 'requires_action'])('keeps a genuine %s refund nonblocking and unconfirmed', async status => {
    const f = await h.accepted();
    const [s] = await (await producer(f, h.publication, Buffer.from(JSON.stringify({ ...f.object, status }))).execute(f.message)).publish();
    expect(s.normalized_outcome.disposition).toBe('AWAITING_CONFIRMATION');
    await expect(h.read(f)).resolves.toHaveLength(1);
  });

  it('preserves preparation COMMIT without claiming a provider request occurred', async () => {
    const f = await h.accepted();
    const database: ObservationTransactions = { async transaction(work) {
      await h.publication.transaction(work);
      throw new Error('review interruption after preparation commit');
    } };
    await expect(producer(f, database).execute(f.message)).rejects.toThrow('interruption');
    expect(f.transport.calls).toHaveLength(0);
    expect(await h.db.sql`select id from provider_command_executions where outbox_id=${f.outboxId}`).toHaveLength(1);
    expect((await snapshot(f)).sources).toBe(0);
    await (await f.producer.execute(f.message)).publish();
    expect(f.transport.calls[0][4]['Idempotency-Key']).toBe(f.message.payload.idempotencyKey);
  });

  it('recognizes a committed observation after publication acknowledgment is lost', async () => {
    const f = await h.accepted(); let loseReply = false;
    const database: ObservationTransactions = { async transaction(work) {
      const result = await h.publication.transaction(work);
      if (loseReply) throw new Error('review lost COMMIT acknowledgment');
      return result;
    } };
    const pending = await producer(f, database).execute(f.message); loseReply = true;
    await expect(pending.publish()).rejects.toThrow('acknowledgment');
    const before = await snapshot(f); expect(before.sources).toBe(1);
    loseReply = false; await pending.publish();
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(['before', 'after'].flatMap(timing => ['provider_observation_sources', 'provider_observation_obligations',
    'provider_financial_observations', 'provider_observation_projections'].map(table => ({ timing, table }))))(
    'rolls back all evidence/revisions on $timing INSERT $table failure', async ({ timing, table }) => {
      const f = await h.accepted(), before = await snapshot(f), pending = await f.producer.execute(f.message);
      await h.db.sql`create or replace function public.d02_review_abort() returns trigger language plpgsql as
        $$ begin raise exception 'independent D02 SQL abort'; end $$`;
      await h.db.sql.unsafe(`create trigger d02_review_abort ${timing} insert on public.${table} for each row execute function public.d02_review_abort()`);
      try { await expect(pending.publish()).rejects.toThrow('independent D02 SQL abort'); }
      finally { await h.db.sql.unsafe(`drop trigger d02_review_abort on public.${table}`); }
      expect(await snapshot(f)).toEqual(before);
      expect(f.transport.calls).toHaveLength(1);
      await pending.publish(); expect(f.transport.calls).toHaveLength(1);
      expect(await snapshot(f)).toMatchObject({ sources: 1, obligations: 1, projections: 1 });
    });

  async function schedule(
    first: (database: ObservationTransactions) => Promise<unknown>,
    second: () => Promise<unknown>,
    base: ObservationTransactions = h.publication,
    holdAll = false,
  ) {
    let release!: () => void, locked!: () => void, backend = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const database: ObservationTransactions = { transaction: work => base.transaction(async tx => {
      backend = Number((await tx`select pg_backend_pid() pid`)[0].pid);
      const result = await work(tx);
      if (holdAll || Array.isArray(result)) { locked(); await gate; }
      return result;
    }) };
    const holding = first(database);
    let contender: Promise<unknown> | undefined;
    try {
      await Promise.race([ready, holding.then(() => { throw new Error('review transaction did not hold'); })]);
      contender = second(); void contender.catch(() => undefined);
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        waiting = (await h.db.sql`select 1 from pg_stat_activity where ${backend}=any(pg_blocking_pids(pid))`).length > 0;
        if (!waiting) await delay(10);
      }
      expect(waiting).toBe(true);
    } finally { release(); await Promise.allSettled([holding, ...(contender ? [contender] : [])]); }
    await holding;
    return contender;
  }

  it.each([false, true])('serializes terminal contradiction publications in both orders, failure first=%s', async failureFirst => {
    const f = await h.accepted(), failed = Buffer.from(JSON.stringify({ ...f.object, status: 'failed' }));
    const firstBytes = failureFirst ? failed : f.raw, secondBytes = failureFirst ? f.raw : failed;
    const two = await producer(f, h.peerPublication, secondBytes).execute(f.message);
    await schedule(async db => (await producer(f, db, firstBytes).execute(f.message)).publish(), () => two.publish());
    const rows = await h.db.sql<{ reason: string }[]>`select normalized_outcome->>'reason' reason from provider_observation_sources where outbox_id=${f.outboxId} order by source_order`;
    expect(rows.map(r => r.reason)).toEqual([failureFirst ? 'DEFINITIVE_PROVIDER_FAILURE' : 'CONFIRMED_PROVIDER_RESULT', 'CONTRADICTORY_PROVIDER_RESULT']);
    expect((await snapshot(f)).sources).toBe(2);
  });

  it.each([false, true])('serializes lookup versus command result in both orders, lookup first=%s', async lookupFirst => {
    const f = await h.accepted(), [prior] = await (await f.producer.execute(f.message)).publish();
    const [run] = await h.db.sql<{ id: string }[]>`insert into reconciliation_runs default values returning id`;
    const lookup = { objectId: f.object.id, priorSourceId: prior.id, reconciliationRunId: run.id, actor: 'independent-review' };
    const two = lookupFirst ? await producer(f, h.peerPublication).execute(f.message)
      : await producer(f, h.peerPublication).lookup(f.outboxId, lookup);
    await schedule(async db => (await (lookupFirst ? producer(f, db).lookup(f.outboxId, lookup)
      : producer(f, db).execute(f.message))).publish(), () => two.publish());
    expect(await h.db.sql`select source_kind from provider_observation_sources where outbox_id=${f.outboxId} order by source_order`)
      .toEqual([{ source_kind: 'COMMAND_RESULT' }, { source_kind: lookupFirst ? 'PROVIDER_LOOKUP' : 'COMMAND_RESULT' },
        { source_kind: lookupFirst ? 'COMMAND_RESULT' : 'PROVIDER_LOOKUP' }]);
  });

  it.each([false, true])('retains independent result and signed receipt during concurrency, receipt first=%s', async receiptFirst => {
    const f = await h.accepted(), event = signedEvidence(f), signed = h.sign(event.raw);
    const receipt = (db: ObservationTransactions = receiptDatabase) => new TrustedSignedReceiptService(db,
      { account: f.account, webhookSecret: 'whsec_isolated_evidence_fixture' }, new Stripe('sk_test_review_fixture'))
      .receive(signed.raw, signed.signature);
    if (receiptFirst) {
      const pending = await producer(f, h.peerPublication).execute(f.message);
      await schedule(db => receipt(db), () => pending.publish(), receiptDatabase, true);
    } else await schedule(async db => (await producer(f, db).execute(f.message)).publish(), () => receipt());
    expect((await snapshot(f)).sources).toBe(1);
    expect(await h.db.sql`select inbox_id from provider_financial_receipts where provider_account=${f.account}`).toHaveLength(1);
    await expect(h.read(f)).rejects.toThrow('blocked');
  });

  it.each([false, true])('serializes unscoped and known-scope observations, unknown first=%s', async unknownFirst => {
    const known = await h.accepted(), unknown = await h.accepted('REFUND', known);
    const unknownRaw = Buffer.from(JSON.stringify({ ...unknown.object,
      metadata: { ...unknown.object.metadata, merchantId: randomUUID() } }));
    const first = unknownFirst ? unknown : known, second = unknownFirst ? known : unknown;
    const pending = await producer(second, h.peerPublication, unknownFirst ? known.raw : unknownRaw).execute(second.message);
    await schedule(async db => (await producer(first, db, unknownFirst ? unknownRaw : known.raw).execute(first.message)).publish(),
      () => pending.publish());
    const rows = await h.db.sql`select merchant_id,disposition from provider_observation_obligations where provider_account=${known.account}`;
    expect(rows).toEqual(expect.arrayContaining([{ merchant_id: null, disposition: 'BLOCKING_REVIEW' },
      { merchant_id: known.merchantId, disposition: 'AWAITING_APPLICATION' }]));
    await expect(h.read(known)).rejects.toThrow('blocked');
  });

  it.each([false, true])('serializes an unknown-owner response with a clearance reader, response first=%s', async responseFirst => {
    const f = await h.accepted(), raw = Buffer.from(JSON.stringify({ ...f.object,
      metadata: { ...f.object.metadata, merchantId: randomUUID() } }));
    if (responseFirst) {
      await expect(schedule(async db => (await producer(f, db, raw).execute(f.message)).publish(), () => h.read(f)))
        .rejects.toThrow('blocked');
    } else {
      const pending = await producer(f, h.peerPublication, raw).execute(f.message);
      await schedule(db => db.transaction(tx => tx`select * from public.inspect_receipt_admission('STRIPE',${f.account},${f.merchantId},'USD',null,null)`),
        () => pending.publish(), h.db);
    }
    expect((await snapshot(f)).sources).toBe(1);
    await expect(h.read(f)).rejects.toThrow('blocked');
  });

  it('redelivered broker execution waits for ongoing publication and preserves the original provider key', async () => {
    const f = await h.accepted();
    await schedule(async db => (await producer(f, db).execute(f.message)).publish(), async () => {
      await (await producer(f, h.peerPublication).execute(f.message)).publish();
    });
    expect((await snapshot(f)).sources).toBe(2);
    const rows = await h.db.sql`select distinct request_headers->>'idempotency-key' key from provider_observation_sources where outbox_id=${f.outboxId}`;
    expect(rows).toEqual([{ key: f.message.payload.idempotencyKey }]);
    expect(await h.db.sql`select id from provider_command_executions where outbox_id=${f.outboxId}`).toHaveLength(2);
  });

  it('refuses stale scope and account clearance after a committed provider source', async () => {
    const f = await h.accepted(), [old] = await h.read(f);
    await (await f.producer.execute(f.message)).publish();
    await expect(h.read(f, String(old.scope_revision), String(old.intake_revision))).rejects.toThrow('Stale');
  });

  it('has no active scopes or provider financial writer privilege', async () => {
    expect(await h.db.sql`select 1 from capture_accounting_scopes where status='ACTIVE'`).toHaveLength(0);
    await expect(h.observationSql`select public.accept_provider_command(${randomUUID()},'acct_fake','TEST')`).rejects.toThrow('permission denied');
    await expect(h.observationSql`insert into ledger_transactions(business_type,business_id,description) values('FORGED',${randomUUID()},'review')`).rejects.toThrow('permission denied');
  });
});
