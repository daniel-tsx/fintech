import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paymentOperationHarness, type PaymentEvent, type PaymentObject } from '../support/payment-operation-harness';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import { ScriptedStripeHttp } from '../support/provider-observation-harness';
import { TrustedSignedReceiptService } from '../../src/webhooks/trusted-signed-receipt.service';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
describeDb('R2-B1.1 complete command and signed evidence consistency', () => {
  let h: Awaited<ReturnType<typeof paymentOperationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  beforeAll(async () => { h = await paymentOperationHarness(); }, 30000);
  afterAll(async () => {
    if (!h) return;
    try {
      const [summary] = await h.db.sql`select version() postgres_version,
        (select count(*)::int from capture_accounting_scopes where status='ACTIVE') active_scopes,
        (select count(*)::int from financial_application_contracts) contracts,
        (select count(*)::int from financial_application_scope_authority) enrollments,
        (select count(*)::int from financial_application_permits) permits,
        (select count(*)::int from financial_applications) applications,
        (select count(*)::int from financial_application_dispositions) dispositions,
        (select count(*)::int from ledger_transactions) journals,
        (select count(*)::int from capture_accounting_lots) lots,
        (select count(*)::int from payment_operation_evidence) proofs,
        (select count(*)::int from financial_evidence_reviews) reviews`;
      expect(summary).toMatchObject({ active_scopes: 0, contracts: 0, enrollments: 0, permits: 0, applications: 0, dispositions: 0, journals: 0, lots: 0 });
      writeFileSync(resolve(__dirname, '../../../../.tmp/r2b11-committed.json'), JSON.stringify(summary, null, 2) + '\n');
    } finally { await h.close(); }
  });
  const read = (f: Fixture) => h.evidence.read(f.inboxId, f.operation === 'AUTHORIZE' ? 'payment.authorized' : f.operation === 'VOID' ? 'payment.cancelled' : 'payment.capture_succeeded');
  async function sources(f: Fixture) {
    return h.db.sql`select id,fingerprint,response_body from provider_observation_sources where outbox_id in (${f.auth.outboxId},${f.accepted.outboxId}) order by id`;
  }
  async function proofs(f: Fixture) {
    return h.db.sql`select id,fingerprint,facts from payment_operation_evidence where inbox_id=${f.inboxId}`;
  }
  async function zeroMoney(f: Fixture) {
    expect((await h.db.sql`select captured_amount::text captured,platform_fee_amount::text fee from payments where id=${f.paymentId}`)[0]).toEqual({ captured: '0', fee: '0' });
    expect((await h.db.sql`select status from payment_attempts where id=${f.accepted.id}`)[0].status).toBe('PENDING');
    expect(await h.db.sql`select id from ledger_transactions where business_id=${f.accepted.id}`).toHaveLength(0);
    expect(await h.db.sql`select id from capture_accounting_lots where payment_id=${f.paymentId}`).toHaveLength(0);
  }
  async function blocked(f: Fixture, sealed: boolean) {
    const before = await proofs(f), originals = await sources(f);
    if (sealed) await expect(read(f)).rejects.toThrow();
    expect(await f.seal()).toMatchObject({ state: 'BLOCKING_REVIEW' });
    expect(await proofs(f)).toEqual(before);
    expect(await sources(f)).toEqual(originals);
    const [obligation] = await h.db.sql`select disposition,review_id from receipt_admission_obligations where inbox_id=${f.inboxId}`;
    expect(obligation.disposition).toBe('BLOCKING_REVIEW');
    expect(await h.db.sql`select id from financial_evidence_reviews where id=${String(obligation.review_id)}`).toHaveLength(1);
    await zeroMoney(f);
  }
  async function authObject(f: Fixture): Promise<PaymentObject> {
    return (await h.db.sql<{ actual: PaymentObject }[]>`select normalized_outcome->'actual' actual from provider_observation_sources where id=${f.authSource}`)[0].actual;
  }
  async function admit(f: Fixture, event: PaymentEvent) {
    const raw = Buffer.from(JSON.stringify(event));
    return f.receiver.receive(raw, h.sign(raw).signature);
  }
  function distinct(f: Fixture): PaymentEvent {
    return { ...structuredClone(f.event), id: `evt_${randomUUID()}` };
  }
  function producer(f: Fixture, object: PaymentObject, requestId: string) {
    return new TrustedProviderObservations(h.publication, { account: f.account, mode: 'TEST', apiKey: 'sk_test_b11_fixture', maxNetworkRetries: 0 },
      new ScriptedStripeHttp(() => ({ body: Buffer.from(JSON.stringify(object)), headers: { 'request-id': requestId } })));
  }

  it('equivalent authorization retries preserve semantic facts despite harmless response enrichment', async () => {
    const f = await h.fixture(), original = await authObject(f), before = await sources(f);
    Object.assign(original, { description: 'same authorization, additional nonfinancial field' });
    original.metadata.currency = 'USD';
    await f.publish(f.auth, original); await f.publish(f.auth, original);
    expect((await sources(f)).length).toBe(before.length + 2);
    for (const row of before) expect(await sources(f)).toContainEqual(row);
    expect((await f.seal()).state).toBe('SEALED');
    const proof = await read(f); await f.publish(f.auth, original);
    expect(await read(f)).toEqual(proof); await zeroMoney(f);
  });
  const authorizationChanges: [string, (o: PaymentObject) => void][] = [
    ['object identity', o => { o.id = 'pi_other'; }],
    ['charge identity', o => { o.latest_charge = 'ch_other'; }],
    ['received baseline', o => { o.amount_received = 4000; o.amount_capturable = 6000; }],
    ['capturable baseline', o => { o.amount_capturable = 9999; }],
    ['manual capture method', o => { o.capture_method = 'automatic'; }],
    ['explicit authorization currency metadata', o => { o.metadata.currency = 'EUR'; }],
  ];
  it.each(authorizationChanges)('all authorization responses enforce %s', async (_name, change) => {
    const f = await h.fixture(), object = await authObject(f); change(object);
    await f.publish(f.auth, object); await blocked(f, false);
  });
  it('a later owned authorization lookup observes present PI state without rewriting its historical baseline', async () => {
    const f = await h.fixture({ amount: 4000, final: false }), [run] = await h.db.sql<{ id: string }[]>`insert into reconciliation_runs default values returning id`;
    const [lookup] = await (await producer(f, f.event.data.object, 'req_current_lookup').lookup(f.auth.outboxId,
      { objectId: f.pi, priorSourceId: f.authSource, reconciliationRunId: run.id, actor: 'isolated-b11' })).publish();
    expect((await h.db.sql`select source_kind,normalized_outcome->>'reason' reason from provider_observation_sources where id=${lookup.id}`)[0])
      .toEqual({ source_kind: 'PROVIDER_LOOKUP', reason: 'CONFIRMED_PROVIDER_RESULT' });
    expect((await f.seal()).state).toBe('SEALED'); expect(await read(f)).toMatchObject({ capture_principal: '4000' }); await zeroMoney(f);
  });
  it('authorization and void proofs retain coherent repeated command results', async () => {
    for (const operation of ['AUTHORIZE', 'VOID'] as const) {
      const f = await h.fixture({ operation }); await f.publish(f.accepted, f.event.data.object);
      expect((await f.seal()).state).toBe('SEALED'); expect(await read(f)).toMatchObject({ capture_principal: null, outcome: `${operation}_SUCCEEDED` });
      await zeroMoney(f);
    }
  });
  const eventChanges: [string, (e: PaymentEvent) => void][] = [
    ['principal', e => { e.data.object.amount_received = 9999; }],
    ['currency', e => { e.data.object.currency = 'eur'; }],
    ['PI identity', e => { e.data.object.id = 'pi_other'; }],
    ['charge identity', e => { e.data.object.latest_charge = 'ch_other'; }],
    ['provider mode', e => { e.livemode = true; e.data.object.livemode = true; }],
    ['outcome phase', e => { e.type = 'payment_intent.canceled'; e.data.object.status = 'canceled'; }],
    ['explicit owner', e => { e.data.object.metadata.merchantId = randomUUID(); }],
    ['wrong key with owned causal request', e => { e.request.idempotency_key = 'capture:wrong'; }],
    ['unattested request ID with owned key', e => { e.request.id = 'req_unattested'; }],
  ];
  it.each(eventChanges)('a distinct signed event cannot conceal contradictory %s', async (_name, change) => {
    const f = await h.fixture(), event = distinct(f); change(event);
    const receipt = await admit(f, event), bytes = await h.db.sql`select raw_body from provider_financial_receipts where inbox_id=${receipt.id}`;
    await blocked(f, false);
    expect(await h.db.sql`select raw_body from provider_financial_receipts where inbox_id=${receipt.id}`).toEqual(bytes);
    expect(await h.db.sql`select inbox_id from receipt_admission_obligations where inbox_id=${receipt.id}`).toHaveLength(1);
  });
  it('partial capture peers require the same previous capturable witness', async () => {
    const f = await h.fixture({ amount: 4000, final: false }), event = distinct(f); event.data.previous_attributes = { amount_capturable: 9999 };
    await admit(f, event); await blocked(f, false);
  });
  it('equivalent distinct events ignore event identity, delivery time and harmless metadata enrichment', async () => {
    const f = await h.fixture(), event = distinct(f); event.created--; event.data.object.metadata.note = 'informational';
    const receipt = await admit(f, event); expect((await f.seal()).state).toBe('SEALED');
    const original = await read(f);
    expect((await h.evidence.seal(receipt.id, 0, '0', f.sourceId, f.authSource)).state).toBe('SEALED');
    expect(await read(f)).toEqual(original); expect((await proofs(f))[0].id).toBe(original.id); await zeroMoney(f);
  });
  it('an equivalent signed event can name another genuine response request ID for the same key', async () => {
    const f = await h.fixture(), requestId = `req_retry_${randomUUID()}`, event = distinct(f);
    await (await producer(f, f.event.data.object, requestId).execute(f.accepted.message)).publish();
    event.request.id = requestId; const receipt = await admit(f, event);
    expect((await f.seal()).state).toBe('SEALED'); expect(await read(f)).toMatchObject({ capture_principal: '10000' });
    expect((await h.db.sql`select disposition from receipt_admission_obligations where inbox_id=${receipt.id}`)[0].disposition).toBe('AWAITING_CORRELATION');
    await zeroMoney(f);
  });
  it('an original signed authorization remains a predecessor, not a contradictory capture event', async () => {
    const f = await h.fixture({ amount: 4000, final: false }), event = distinct(f);
    event.type = 'payment_intent.amount_capturable_updated'; event.data = { object: await authObject(f) };
    event.request = { id: f.auth.requestId, idempotency_key: f.auth.key };
    await admit(f, event); expect((await f.seal()).state).toBe('SEALED'); expect(await read(f)).toMatchObject({ capture_principal: '4000' }); await zeroMoney(f);
  });
  it('a different accepted pending operation sharing the PI retains its own obligation', async () => {
    const f = await h.fixture({ amount: 4000, final: false }), next = await f.command('CAPTURE', randomUUID(), 2000), event = distinct(f);
    event.request = { id: next.requestId, idempotency_key: next.key }; event.data.object.metadata.captureAttemptId = next.id;
    event.data.object.metadata.captureAmount = '2000'; event.data.object.amount_received = 6000; event.data.object.amount_capturable = 4000;
    const receipt = await admit(f, event); expect((await f.seal()).state).toBe('SEALED'); expect(await read(f)).toMatchObject({ capture_principal: '4000' });
    expect((await h.db.sql`select disposition,payment_operation_proof_id from receipt_admission_obligations where inbox_id=${receipt.id}`)[0])
      .toEqual({ disposition: 'AWAITING_CORRELATION', payment_operation_proof_id: null });
    await zeroMoney(f);
  });
  it('an unrelated same-account PI event does not join on amount or metadata', async () => {
    const f = await h.fixture(), event = distinct(f); event.request = { id: 'req_unrelated', idempotency_key: 'capture:unrelated' };
    event.data.object.id = 'pi_unrelated'; event.data.object.amount_received = 1234;
    await admit(f, event); expect((await f.seal()).state).toBe('SEALED'); expect(await read(f)).toMatchObject({ capture_principal: '10000' }); await zeroMoney(f);
  });
  it('a late distinct contradiction blocks a bound proof and preserves every immutable source', async () => {
    const f = await h.fixture(), sealed = await f.seal(); await h.evidence.bind(f.inboxId, sealed.proof_id!, '0');
    const before = await proofs(f), originals = await sources(f), event = distinct(f); event.data.object.amount_received = 9999;
    await admit(f, event); await expect(read(f)).rejects.toThrow(/Contradictory/);
    await expect(h.evidence.bind(f.inboxId, sealed.proof_id!, '1')).rejects.toThrow(/Contradictory/);
    expect(await proofs(f)).toEqual(before); expect(await sources(f)).toEqual(originals);
    expect((await h.db.sql`select disposition,payment_operation_proof_id from receipt_admission_obligations where inbox_id=${f.inboxId}`)[0])
      .toEqual({ disposition: 'AWAITING_APPLICATION', payment_operation_proof_id: sealed.proof_id });
    await zeroMoney(f);
  });
  it('contradictory later delivery on a coherent peer cannot hide behind its original event', async () => {
    const f = await h.fixture(), event = distinct(f); await admit(f, event); expect((await f.seal()).state).toBe('SEALED');
    event.data.object.amount_received = 9999; expect(await admit(f, event)).toMatchObject({ classification: 'CONFLICT' });
    await blocked(f, true);
  });
  it('equivalent retries and reordered duplicates never erase an intervening contradiction', async () => {
    const f = await h.fixture(); expect((await f.seal()).state).toBe('SEALED'); const equivalent = distinct(f);
    await admit(f, equivalent); expect(await read(f)).toMatchObject({ capture_principal: '10000' });
    const conflict = distinct(f); conflict.data.object.amount_received = 9999; await admit(f, conflict);
    await f.publish(f.auth, await authObject(f)); await admit(f, equivalent);
    await blocked(f, true);
  });
  it('aborted signed publication leaves no contradiction; retry commits it and invalidates eligibility', async () => {
    const f = await h.fixture(); expect((await f.seal()).state).toBe('SEALED'); const before = await proofs(f), event = distinct(f);
    event.data.object.amount_received = 9999; const raw = Buffer.from(JSON.stringify(event));
    const receiver = new TrustedSignedReceiptService({ transaction: work => h.receipt.publication.transaction(async tx => {
      await work(tx); throw new Error('planned signed publication rollback');
    }) }, { account: f.account, webhookSecret: h.receipt.secret, admissionContract: 'PAYMENT_OPERATION_V2' }, h.receipt.stripe);
    await expect(receiver.receive(raw, h.sign(raw).signature)).rejects.toThrow('planned signed publication rollback');
    expect(await h.db.sql`select id from webhook_events where provider_event_id=${event.id}`).toHaveLength(0);
    expect(await read(f)).toMatchObject({ capture_principal: '10000' });
    await f.receiver.receive(raw, h.sign(raw).signature); await blocked(f, true); expect(await proofs(f)).toEqual(before);
  });
});
