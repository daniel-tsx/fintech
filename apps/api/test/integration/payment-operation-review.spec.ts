import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paymentOperationHarness } from '../support/payment-operation-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeDb('R2-B1 independent reviewer source consistency', () => {
  let h: Awaited<ReturnType<typeof paymentOperationHarness>>;
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  beforeAll(async () => { h = await paymentOperationHarness(); }, 30000);
  afterAll(async () => {
    if (!h) return;
    try {
      const [summary] = await h.db.sql`select current_database() database,version() postgres_version,
        (select count(*)::int from capture_accounting_scopes where status='ACTIVE') active_scopes,
        (select count(*)::int from financial_application_contracts) contracts,
        (select count(*)::int from financial_application_scope_authority) enrollments,
        (select count(*)::int from financial_application_permits) permits,
        (select count(*)::int from financial_applications) applications,
        (select count(*)::int from financial_application_dispositions) dispositions,
        (select count(*)::int from ledger_transactions) journals,
        (select count(*)::int from capture_accounting_lots) lots`;
      const proofs = await h.db.sql`select e.id,e.inbox_id,e.capture_principal::text,e.authorization_source_id,
        o.disposition,o.obligation_revision::text,o.payment_operation_proof_id
        from payment_operation_evidence e join receipt_admission_obligations o using(inbox_id) order by e.inbox_id`;
      const sources = await h.db.sql`select s.outbox_id,a.operation,s.normalized_outcome->>'reason' reason,
        s.normalized_outcome#>>'{actual,amount_received}' received,
        s.normalized_outcome#>>'{actual,amount_capturable}' capturable,count(*)::int n
        from provider_observation_sources s join provider_command_authorities a using(outbox_id)
        group by s.outbox_id,a.operation,reason,received,capturable order by s.outbox_id,received`;
      writeFileSync(resolve(__dirname, '../../../../.tmp/r2b1-review-committed.json'), JSON.stringify({ summary, proofs, sources }, null, 2) + '\n');
      expect(summary).toMatchObject({ active_scopes: 0, contracts: 0, enrollments: 0, permits: 0, applications: 0, dispositions: 0, journals: 0, lots: 0 });
    } finally { await h.close(); }
  });

  async function unchangedMoney(f: Fixture) {
    expect((await h.db.sql`select captured_amount::text captured, platform_fee_amount::text fee from payments where id=${f.paymentId}`)[0])
      .toEqual({ captured: '0', fee: '0' });
    expect((await h.db.sql`select status from payment_attempts where id=${f.accepted.id}`)[0].status).toBe('PENDING');
    expect(await h.db.sql`select id from ledger_transactions where business_id=${f.accepted.id}`).toHaveLength(0);
    expect(await h.db.sql`select id from capture_accounting_lots where payment_id=${f.paymentId}`).toHaveLength(0);
    expect(await h.db.sql`select root_id from financial_applications`).toHaveLength(0);
    expect(await h.db.sql`select merchant_id from capture_accounting_scopes where status='ACTIVE'`).toHaveLength(0);
  }

  async function conflictingAuthorization(f: Fixture) {
    const [source] = await h.db.sql<{ normalized_outcome: { actual: unknown } }[]>`
      select normalized_outcome from provider_observation_sources where id=${f.authSource}`;
    const object = structuredClone(source.normalized_outcome.actual) as typeof f.event.data.object;
    object.amount_received = 4000;
    object.amount_capturable = 6000;
    const id = await f.publish(f.auth, object);
    expect((await h.db.sql`select normalized_outcome->>'reason' reason from provider_observation_sources where id=${id}`)[0].reason)
      .toBe('CONFIRMED_PROVIDER_RESULT');
    return id;
  }

  async function conflictingSignedSuccess(f: Fixture) {
    const event = structuredClone(f.event);
    event.id = `evt_${randomUUID()}`;
    event.data.object.amount_received = 9999;
    const raw = Buffer.from(JSON.stringify(event));
    const receipt = await f.receiver.receive(raw, h.sign(raw).signature);
    expect((await h.db.sql`select contract_version,operation from receipt_admissions where inbox_id=${receipt.id}`)[0])
      .toEqual({ contract_version: 2, operation: 'payment.capture_succeeded' });
    expect(receipt.id).not.toBe(f.inboxId);
    return receipt.id;
  }

  it('control: first partial principal exists before any journal or lot', async () => {
    const f = await h.fixture({ amount: 4000, final: false });
    const sealed = await f.seal();
    expect(sealed.state).toBe('SEALED');
    expect(await h.evidence.read(f.inboxId, 'payment.capture_succeeded'))
      .toMatchObject({ capture_principal: '4000', source_id: f.sourceId, authorization_source_id: f.authSource });
    await unchangedMoney(f);
  });

  it('refuses a selected zero baseline when another genuine authorization response contradicts it', async () => {
    const f = await h.fixture();
    await conflictingAuthorization(f);
    await unchangedMoney(f);
    expect(await f.seal()).toMatchObject({ state: 'BLOCKING_REVIEW' });
  });

  it('SQL reader rejects a late contradictory authorization response and preserves sealed identity', async () => {
    const f = await h.fixture();
    const sealed = await f.seal();
    expect(sealed.state).toBe('SEALED');
    const original = await h.evidence.read(f.inboxId, 'payment.capture_succeeded') as { id: string; fingerprint: Buffer };
    await conflictingAuthorization(f);
    expect((await h.db.sql`select id,fingerprint from payment_operation_evidence where inbox_id=${f.inboxId}`)[0])
      .toEqual({ id: original.id, fingerprint: original.fingerprint });
    await unchangedMoney(f);
    await expect(h.evidence.read(f.inboxId, 'payment.capture_succeeded')).rejects.toThrow();
  });

  it('refuses contradictory signed success under a distinct event identity before sealing', async () => {
    const f = await h.fixture();
    await conflictingSignedSuccess(f);
    await unchangedMoney(f);
    expect(await f.seal()).toMatchObject({ state: 'BLOCKING_REVIEW' });
  });

  it('SQL reader rejects a late distinct signed success with an incompatible principal', async () => {
    const f = await h.fixture();
    expect((await f.seal()).state).toBe('SEALED');
    await conflictingSignedSuccess(f);
    await unchangedMoney(f);
    await expect(h.evidence.read(f.inboxId, 'payment.capture_succeeded')).rejects.toThrow();
  });

  it('control: distinct coherent signed success retains its own independently provable source', async () => {
    const f = await h.fixture();
    const event = structuredClone(f.event);
    event.id = `evt_${randomUUID()}`;
    const raw = Buffer.from(JSON.stringify(event));
    const receipt = await f.receiver.receive(raw, h.sign(raw).signature);
    expect((await f.seal()).state).toBe('SEALED');
    expect(await h.evidence.seal(receipt.id, 0, '0', f.sourceId, f.authSource)).toMatchObject({ state: 'SEALED' });
    await unchangedMoney(f);
  });

  it.each(['neither', 'both', 'partial-owner'])('rejects the %s proof-owner shape in PostgreSQL', async shape => {
    const f = await h.fixture();
    const sealed = await f.seal();
    expect(sealed.state).toBe('SEALED');
    const [owner] = await h.db.sql<{ role_name: string }[]>`select 'fintech_admission_'||md5(current_database()) role_name`;
    // Test administrator isolates the CHECK itself. Real publication, sealing,
    // reading and binding elsewhere use authenticated restricted LOGIN pools.
    await expect(h.db.sql.begin(async tx => {
      await tx.unsafe(`set local role "${owner.role_name}"`);
      await tx`update receipt_admission_obligations set merchant_id=${f.merchantId},payment_id=${f.paymentId},
        currency=${shape === 'partial-owner' ? null : 'USD'},scope_evidence_revision=1,
        proof_revision=${shape === 'both' ? 1 : null},
        payment_operation_proof_id=${shape === 'neither' ? null : sealed.proof_id!},
        disposition='AWAITING_APPLICATION',obligation_revision=1 where inbox_id=${f.inboxId}`;
    })).rejects.toThrow(/receipt_obligation_typed_owner/);
    expect((await h.db.sql`select merchant_id,payment_operation_proof_id,obligation_revision::text from receipt_admission_obligations where inbox_id=${f.inboxId}`)[0])
      .toEqual({ merchant_id: null, payment_operation_proof_id: null, obligation_revision: '0' });
    await unchangedMoney(f);
  });
});
