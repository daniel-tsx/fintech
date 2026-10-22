import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paymentOperationHarness, type PaymentEvent, type PaymentObject } from '../support/payment-operation-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
describeDb('R2-B1.2 primary parity, causal identity and authorization acceptance', () => {
  let h: Awaited<ReturnType<typeof paymentOperationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  const observations: unknown[] = [];
  beforeAll(async () => { h = await paymentOperationHarness(); }, 30000);
  afterAll(async () => {
    if (!h) return;
    try {
      const [summary] = await h.db.sql`select version() postgres_version,
        (select count(*)::int from capture_accounting_scopes where status='ACTIVE') active_scopes,
        (select count(*)::int from financial_application_contracts) contracts,
        (select count(*)::int from financial_application_scope_authority) enrollments,
        (select count(*)::int from financial_applications) applications,
        (select count(*)::int from financial_application_permits) permits,
        (select count(*)::int from financial_application_dispositions) dispositions,
        (select count(*)::int from ledger_transactions) journals,
        (select count(*)::int from capture_accounting_lots) lots`;
      expect(summary).toMatchObject({ active_scopes: 0, contracts: 0, enrollments: 0, applications: 0, permits: 0, dispositions: 0, journals: 0, lots: 0 });
      writeFileSync(resolve(__dirname, '../../../../.tmp/r2b12-acceptance-committed.json'), JSON.stringify({ summary, observations }, null, 2) + '\n');
    } finally { await h.close(); }
  });
  const operation = (f: Fixture) => f.operation === 'AUTHORIZE' ? 'payment.authorized' : 'payment.capture_succeeded';
  const read = (f: Fixture) => h.evidence.read(f.inboxId, operation(f));
  async function outcome(work: () => Promise<unknown>) {
    try { return { sqlstate: null, result: await work(), message: null }; }
    catch (error) { const e = error as { code: string; message: string }; return { sqlstate: e.code, result: null, message: e.message }; }
  }
  async function sourceHistory(f: Fixture) {
    return h.db.sql`select id,outbox_id,fingerprint,response_body from provider_observation_sources where outbox_id in (${f.auth.outboxId},${f.accepted.outboxId}) order by id`;
  }
  async function sample(label: string, f: Fixture) {
    const sources = await sourceHistory(f);
    const facts = await outcome(() => h.db.sql`select public.payment_operation_facts(${f.inboxId},${f.sourceId},${f.operation === 'AUTHORIZE' ? null : f.authSource}) facts`);
    const seal = await f.seal();
    const effective = await outcome(() => read(f));
    const [state] = await h.db.sql`select o.disposition,o.payment_operation_proof_id,o.review_id,
      (select count(*)::int from payment_operation_evidence where inbox_id=${f.inboxId}) proofs,
      (select captured_amount::text from payments where id=${f.paymentId}) captured,
      (select platform_fee_amount::text from payments where id=${f.paymentId}) fee,
      (select status from payment_attempts where id=${f.accepted.id}) attempt,
      (select convert_from(raw_body,'UTF8')::jsonb#>>'{data,object,capture_method}' from provider_financial_receipts where inbox_id=${f.inboxId}) signed_method,
      (select normalized_outcome#>>'{actual,capture_method}' from provider_observation_sources where id=${f.sourceId}) response_method
      from receipt_admission_obligations o where o.inbox_id=${f.inboxId}`;
    expect(state).toMatchObject({ captured: '0', fee: '0', attempt: 'PENDING' });
    expect(await sourceHistory(f)).toEqual(sources);
    const receipts = await h.db.sql`select inbox_id,raw_body,sha256(raw_body) raw_digest from provider_financial_receipts where provider_account=${f.account} order by inbox_id`;
    observations.push({ label, inbox: f.inboxId, source: f.sourceId, authorization: f.authSource, facts, seal, effective, state, sources, receipts });
    return { facts, seal, effective, state };
  }
  async function admit(f: Fixture, event: PaymentEvent) {
    const raw = Buffer.from(JSON.stringify(event)); return f.receiver.receive(raw, h.sign(raw).signature);
  }
  async function customer(f: Fixture, transform: (raw: string) => string, request: { id: string; idempotency_key: string } | string | null = { id: 'req_other', idempotency_key: 'other' }) {
    const raw = Buffer.from(transform(JSON.stringify({ id: `evt_${randomUUID()}`, object: 'event', account: f.account, created: Math.floor(Date.now() / 1000),
      type: 'customer.updated', request, data: { object: { id: 'cus_unrelated', object: 'customer', metadata: { note: 'info' } } } })));
    const receipt = await f.receiver.receive(raw, h.sign(raw).signature);
    expect((await h.db.sql`select a.operation,a.financially_relevant,(select count(*)::int from receipt_admission_obligations where inbox_id=${receipt.id}) obligations
      from receipt_admissions a where inbox_id=${receipt.id}`)[0]).toEqual({ operation: 'provider.unrelated', financially_relevant: false, obligations: 0 });
    return receipt;
  }

  it.each(['automatic', 'null'])('the selected signed method %s uses the peer consistency predicate', async method => {
    const f = await h.fixture({ raw: raw => raw.replace('"capture_method":"manual"', `"capture_method":${method === 'null' ? 'null' : '"automatic"'}`) });
    const r = await sample(`primary-${method}`, f);
    expect(r.facts.sqlstate).toBe('P0001'); expect(r.seal.state).toBe('BLOCKING_REVIEW'); expect(r.state.proofs).toBe(0);
  });
  it('a late automatic peer invalidates an earlier manual proof without changing its history', async () => {
    const f = await h.fixture(), sealed = await f.seal(); expect(sealed.state).toBe('SEALED');
    const original = await read(f); await h.evidence.bind(f.inboxId, sealed.proof_id!, '0');
    const event = structuredClone(f.event); event.id = `evt_${randomUUID()}`; event.data.object.capture_method = 'automatic'; await admit(f, event);
    const result = await outcome(() => read(f)); expect(result.sqlstate).toBe('P0001');
    expect(await outcome(() => h.evidence.bind(f.inboxId, sealed.proof_id!, '1'))).toMatchObject({ sqlstate: 'P0001' });
    const [persisted] = await h.db.sql`select * from payment_operation_evidence where inbox_id=${f.inboxId}`;
    expect(persisted).toEqual(original); observations.push({ label: 'late-method', inbox: f.inboxId, result, persisted });
  });
  it('absent optional signed method agrees with an explicit manual peer', async () => {
    const f = await h.fixture({ event: event => { delete (event.data.object as Partial<PaymentObject>).capture_method; } });
    const event = structuredClone(f.event); event.id = `evt_${randomUUID()}`; event.data.object.capture_method = 'manual'; await admit(f, event);
    const r = await sample('optional-method', f); expect(r.facts.sqlstate).toBeNull(); expect(r.seal.state).toBe('SEALED');
  });
  const duplicateNote = (raw: string) => raw.replace('"note":"info"', '"note":"info","note":"info"');
  it.each(['before', 'after'])('unrelated original duplicate informational fields remain isolated %s sealing', async order => {
    const f = await h.fixture(); if (order === 'after') expect((await f.seal()).state).toBe('SEALED');
    await customer(f, duplicateNote); const r = await sample(`unrelated-${order}`, f);
    expect(r.facts.sqlstate).toBeNull(); expect(r.seal.state).toBe('SEALED'); expect(r.effective.sqlstate).toBeNull();
  });
  it('an unrelated equivalent later delivery with duplicate informational fields remains isolated', async () => {
    const f = await h.fixture(); expect((await f.seal()).state).toBe('SEALED');
    const event = { id: `evt_${randomUUID()}`, object: 'event', account: f.account, created: Math.floor(Date.now() / 1000), type: 'customer.updated',
      request: { id: 'req_other', idempotency_key: 'other' }, data: { object: { id: 'cus_other', object: 'customer', metadata: { note: 'info' } } } };
    const original = Buffer.from(JSON.stringify(event)); await f.receiver.receive(original, h.sign(original).signature);
    const duplicate = Buffer.from(duplicateNote(original.toString()));
    expect(await f.receiver.receive(duplicate, h.sign(duplicate).signature)).toMatchObject({ classification: 'EQUIVALENT' });
    const r = await sample('unrelated-later-delivery', f); expect(r.seal.state).toBe('SEALED'); expect(r.effective.sqlstate).toBeNull();
  });
  it('unrelated null request and duplicate informational fields cannot supply payment causation', async () => {
    const f = await h.fixture(); await customer(f, duplicateNote, null);
    const r = await sample('unrelated-null-request', f); expect(r.seal.state).toBe('SEALED');
  });
  it('an unrelated scalar request ID accepted by R1 remains isolated', async () => {
    const f = await h.fixture(); await customer(f, duplicateNote, 'req_unrelated_scalar');
    const r = await sample('unrelated-scalar-request', f); expect(r.facts.sqlstate).toBeNull(); expect(r.seal.state).toBe('SEALED');
  });
  it('a scalar request ID matching an owned response cannot hide insufficient financial causation', async () => {
    const f = await h.fixture(); await customer(f, raw => raw, f.accepted.requestId);
    const r = await sample('owned-scalar-request', f); expect(r.facts.sqlstate).toBe('P0001'); expect(r.seal.state).toBe('BLOCKING_REVIEW');
  });
  const ambiguous: [string, (raw: string, f: Fixture) => string][] = [
    ['key', (raw, f) => raw.replace('"idempotency_key":"other"', `"idempotency_key":"${f.accepted.key}","idempotency_key":"other"`)],
    ['request ID', (raw, f) => raw.replace('"id":"req_other"', `"id":"${f.accepted.requestId}","id":"req_other"`)],
    ['escaped key', (raw, f) => raw.replace('"idempotency_key":"other"', `"idempotency_\\u006bey":"${f.accepted.key}","idempotency_key":"other"`)],
    ['request object', (raw, f) => raw.replace('"request":', `"request":${JSON.stringify({ id: f.accepted.requestId, idempotency_key: f.accepted.key })},"request":`)],
  ];
  it('the new identity parser has no PUBLIC or ordinary correlator execution capability', async () => {
    const [acl] = await h.db.sql`select exists(select 1 from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid='public.payment_receipt_causation(bytea)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') public_execute`;
    expect(acl.public_execute).toBe(false);
    const result = await outcome(() => h.receipt.correlator`select public.payment_receipt_causation(${Buffer.from('{}')})`);
    expect(result.sqlstate).toBe('42501');
  });
  it.each(ambiguous)('ambiguous causal %s cannot be hidden by a lossy unrelated last value', async (name, transform) => {
    const f = await h.fixture(); await customer(f, raw => transform(raw, f));
    const r = await sample(`ambiguous-${name}`, f); expect(r.facts.sqlstate).toBe('P0001'); expect(r.seal.state).toBe('BLOCKING_REVIEW'); expect(r.state.proofs).toBe(0);
  });
  it('late ambiguous causation rejects reading while preserving the original proof', async () => {
    const f = await h.fixture(); expect((await f.seal()).state).toBe('SEALED'); const original = await read(f);
    await customer(f, raw => ambiguous[0][1](raw, f)); const r = await sample('late-ambiguous-causation', f);
    expect(r.facts.sqlstate).toBe('P0001'); expect(r.seal.state).toBe('BLOCKING_REVIEW');
    expect((await h.db.sql`select * from payment_operation_evidence where inbox_id=${f.inboxId}`)[0]).toEqual(original);
  });
  it('a causally relevant duplicate informational field still requires the strict payment parser', async () => {
    const f = await h.fixture(); const event = structuredClone(f.event); event.id = `evt_${randomUUID()}`; event.data.object.metadata.note = 'info';
    const raw = Buffer.from(duplicateNote(JSON.stringify(event))); await f.receiver.receive(raw, h.sign(raw).signature);
    const r = await sample('relevant-duplicate', f); expect(r.facts.sqlstate).toBe('P0001'); expect(r.seal.state).toBe('BLOCKING_REVIEW');
  });
  it('standalone authorization semantic enrichment remains effective after the original proof commits', async () => {
    const f = await h.fixture({ operation: 'AUTHORIZE' }); expect((await f.seal()).state).toBe('SEALED'); const original = await read(f);
    const object = structuredClone(f.event.data.object); Object.assign(object, { description: 'additional nonfinancial field' }); object.metadata.currency = 'USD';
    await f.publish(f.accepted, object); const r = await sample('late-authorization-enrichment', f);
    expect(r.facts.sqlstate).toBeNull(); expect(r.seal.state).toBe('SEALED'); expect(await read(f)).toEqual(original);
  });
  const authContradictions: [string, (object: PaymentObject) => void][] = [
    ['PI', object => { object.id = 'pi_other'; }], ['Charge', object => { object.latest_charge = 'ch_other'; }],
    ['received', object => { object.amount_received = 4000; object.amount_capturable = 6000; }],
    ['capacity', object => { object.amount_capturable = 9999; }], ['method', object => { object.capture_method = 'automatic'; }],
    ['explicit currency', object => { object.metadata.currency = 'EUR'; }],
  ];
  it.each(authContradictions)('standalone authorization retains late %s contradictions', async (name, change) => {
    const f = await h.fixture({ operation: 'AUTHORIZE' }); expect((await f.seal()).state).toBe('SEALED'); const original = await read(f);
    const object = structuredClone(f.event.data.object); change(object); await f.publish(f.accepted, object);
    const r = await sample(`late-authorization-${name}`, f); expect(r.facts.sqlstate).toBe('P0001'); expect(r.seal.state).toBe('BLOCKING_REVIEW');
    expect((await h.db.sql`select * from payment_operation_evidence where inbox_id=${f.inboxId}`)[0]).toEqual(original);
  });
});
