import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DatabaseService, type DbTransaction } from '../../src/database/database.service';
import { publishVerifiedReceipt, signedEvidence, storeOriginalInbox, trustedEvidenceFixture } from '../support/trusted-evidence-fixtures';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

// Independent review reproductions. The publisher has EXECUTE only; fixture
// setup and committed-state inspection use the disposable database owner.
describeDatabase('R0 independent pending-classification regressions', () => {
  let db: DatabaseService;
  let publisher: string;
  let reader: string;
  let worker: string;
  beforeAll(async () => {
    const value = process.env.MIGRATION_ADMIN_URL ?? process.env.DATABASE_URL;
    if (!value) throw new Error('Disposable local database URL required');
    const url = new URL(value);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local cluster required');
    const name = `fintech_r0_review_regressions_${randomUUID().replaceAll('-', '')}`;
    const admin = postgres(value, { max: 1 });
    try { await admin.unsafe(`create database "${name}"`); } finally { await admin.end(); }
    url.pathname = `/${name}`;
    const migration = postgres(url.toString(), { max: 1 });
    try { await migrate(drizzle(migration), { migrationsFolder: resolve(__dirname, '../../drizzle') }); }
    finally { await migration.end(); }
    db = new DatabaseService(new ConfigService({ DATABASE_URL: url.toString() }));
    const suffix = randomUUID().replaceAll('-', '');
    publisher = `r0_review_pub_${suffix}`;
    reader = `r0_review_read_${suffix}`;
    worker = `r0_review_work_${suffix}`;
    for (const role of [publisher, reader, worker]) {
      await db.sql.unsafe(`create role "${role}" nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls`);
      await db.sql.unsafe(`grant usage on schema public to "${role}"`);
    }
    await db.sql.unsafe(`grant execute on function public.publish_admitted_receipt(uuid,text,bytea,text) to "${publisher}"`);
    await db.sql.unsafe(`grant execute on function public.inspect_receipt_admission(text,text,uuid,text,bigint,bigint) to "${reader}"`);
    await db.sql.unsafe(`grant execute on function public.enroll_receipt_admission(uuid,integer), public.bind_receipt_obligation(uuid,integer), public.resolve_receipt_obligation(uuid,text,uuid) to "${worker}"`);
    const directory = resolve(__dirname, '../../../../.tmp');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'r0-independent-regression-db.txt'), name + '\n');
  }, 30000);
  afterAll(async () => {
    if (db) try {
      expect((await db.sql`select count(*)::int as n from capture_accounting_scopes where status='ACTIVE'`)[0].n).toBe(0);
      expect((await db.sql`select count(*)::int as n from financial_evidence_accounts where runtime_enforcement<>'UNINSTALLED'`)[0].n).toBe(0);
    } finally { await db.onApplicationShutdown(); }
  });
  const asRole = <T>(role: string, work: (tx: DbTransaction) => Promise<T>) => db.transaction(async tx => {
    await tx.unsafe(`set local role "${role}"`);
    return work(tx);
  });

  it.each(['refund.succeeded', 'refund.failed'] as const)(
    'pending raw receipt cannot use a nonblocking exemption with normalized %s', async type => {
      const f = await trustedEvidenceFixture(db);
      const signed = signedEvidence(f, { status: 'pending' });
      const inboxId = await storeOriginalInbox(db, { ...signed, payload: {
        ...signed.payload, type, data: { merchantId: f.merchantId, paymentId: f.paymentId,
          refundId: f.refundId, providerTransactionId: f.objectId, amount: 5000, currency: 'USD' },
      } });
      let rejected = false;
      try { await asRole(publisher, tx => tx`select public.publish_admitted_receipt(${inboxId},${f.account},${signed.raw},'isolated-SDK-fixture/v1')`); }
      catch { rejected = true; }
      const [committed] = await db.sql`select
        (select count(*)::int from provider_financial_receipts where inbox_id=${inboxId}) as receipts,
        (select count(*)::int from receipt_admissions where inbox_id=${inboxId}) as admissions,
        (select disposition from receipt_admission_obligations where inbox_id=${inboxId}) as disposition,
        (select count(*)::int from webhook_financial_evidence where inbox_id=${inboxId}) as proofs,
        (select count(*)::int from ledger_transactions where business_type='REFUND' and business_id=${f.refundId}) as refund_journals`;
      let readerClear = false;
      try { await asRole(reader, tx => tx`select * from public.inspect_receipt_admission('STRIPE',${f.account},${f.merchantId},'USD')`); readerClear = true; }
      catch { /* R0.1 requires retained evidence plus a durable review blocker. */ }
      const [original] = await db.sql<{ payload: { type: string } }[]>`select payload from webhook_events where id=${inboxId}`;
      expect(original.payload.type).toBe(type);
      // Original fixtures and names retained. The pre-correction rejection
      // oracle is saved in the review record; R0.1 explicitly requires retention.
      expect({ rejected, ...committed, readerClear }).toEqual({ rejected: false, receipts: 1,
        admissions: 1, disposition: 'BLOCKING_REVIEW', proofs: 0, refund_journals: 0, readerClear: false });
      await expectBlocked(inboxId, f);
    },
  );

  it('genuine version1 pending normalization remains Option A neutral', async () => {
    const f = await trustedEvidenceFixture(db), signed = signedEvidence(f, { status: 'pending' });
    expect(signed.payload).toMatchObject({ type: 'provider.unsupported', data: null });
    const inboxId = await storeOriginalInbox(db, signed);
    await asRole(publisher, tx => tx`select public.publish_admitted_receipt(${inboxId},${f.account},${signed.raw},'isolated-SDK-fixture/v1')`);
    expect((await db.sql`select operation,disposition from receipt_admission_obligations where inbox_id=${inboxId}`)[0])
      .toEqual({ operation: 'refund.pending', disposition: 'AWAITING_CONFIRMATION' });
    expect(await asRole(reader, tx => tx`select * from public.inspect_receipt_admission('STRIPE',${f.account},${f.merchantId},'USD')`)).toHaveLength(1);
  });

  type Fixture = Awaited<ReturnType<typeof trustedEvidenceFixture>>;
  const inspect = (f: Fixture, scope: string | null = null, intake: string | null = null) => asRole(reader,
    tx => tx`select * from public.inspect_receipt_admission('STRIPE',${f.account},${f.merchantId},'USD',${scope},${intake})`);
  const obligation = async (id: string) => (await db.sql`select * from receipt_admission_obligations where inbox_id=${id}`)[0];
  const publish = (f: Fixture, id: string, raw: Buffer) => asRole(publisher,
    tx => tx`select public.publish_admitted_receipt(${id},${f.account},${raw},'isolated-SDK-fixture/v1')`);
  async function expectBlocked(id: string, f: Fixture) {
    const row = await obligation(id);
    expect(row).toMatchObject({ disposition: 'BLOCKING_REVIEW', merchant_id: null, currency: null,
      payment_id: null, proof_revision: null, resolution_id: null, intake_evidence_revision: '1' });
    expect((await db.sql`select inbox_id,reason,observations from financial_evidence_reviews where id=${String(row.review_id)}`)[0])
      .toMatchObject({ inbox_id: id, reason: 'CONTRADICTORY', observations: { classifier: 'receipt-admission/v1' } });
    await expect(inspect(f)).rejects.toThrow(/blocked/);
    expect(await db.sql`select id from receipt_obligation_resolutions where inbox_id=${id}`).toHaveLength(0);
  }
  async function contradiction(status = 'pending', changes: Record<string, unknown> = {}) {
    const f = await trustedEvidenceFixture(db), signed = signedEvidence(f, { status });
    const payload = { ...signed.payload, type: 'refund.succeeded' as const, data: { merchantId: f.merchantId,
      paymentId: f.paymentId, refundId: f.refundId, providerTransactionId: f.objectId, amount: 5000,
      currency: 'USD', ...changes } };
    const id = await storeOriginalInbox(db, { ...signed, payload });
    return { f, signed, payload, id };
  }

  it.each(['refund.succeeded', 'refund.failed'] as const)('requires_action cannot hide normalized %s', async type => {
    const f = await trustedEvidenceFixture(db), signed = signedEvidence(f, { status: 'requires_action' });
    const id = await storeOriginalInbox(db, { ...signed, payload: { ...signed.payload, type,
      data: { merchantId: f.merchantId, paymentId: f.paymentId, refundId: f.refundId, providerTransactionId: f.objectId, amount: 5000, currency: 'USD' } } });
    await publish(f, id, signed.raw); await expectBlocked(id, f);
  });
  it('genuine requires_action remains neutral without a posted hold', async () => {
    const f = await trustedEvidenceFixture(db), signed = signedEvidence(f, { status: 'requires_action' });
    const id = await storeOriginalInbox(db, signed); await publish(f, id, signed.raw);
    expect(await obligation(id)).toMatchObject({ disposition: 'AWAITING_CONFIRMATION', review_id: null });
    expect(await inspect(f)).toHaveLength(1);
    expect(await db.sql`select id from ledger_transactions where business_type='REFUND' and business_id=${f.refundId}`).toHaveLength(0);
  });
  it.each(['succeeded', 'failed', 'canceled'])('matching %s remains blocked pending trusted financial disposition', async status => {
    const f = await trustedEvidenceFixture(db), signed = signedEvidence(f, { status });
    const id = await storeOriginalInbox(db, signed); await publish(f, id, signed.raw);
    expect(await obligation(id)).toMatchObject({ operation: status === 'succeeded' ? 'refund.succeeded' : 'refund.failed',
      disposition: 'AWAITING_CORRELATION', review_id: null });
    await expect(inspect(f)).rejects.toThrow(/blocked/);
  });
  it.each([
    ['amount', { amount: 4999 }], ['currency', { currency: 'EUR' }],
    ['merchant', { merchantId: randomUUID() }], ['payment', { paymentId: randomUUID() }],
    ['refund', { refundId: randomUUID() }], ['object', { providerTransactionId: 're_wrong' }],
    ['provider status', { providerStatus: 'pending' }],
  ])('confirmed outcome with contradictory normalized %s retains review', async (_label, changes) => {
    const { f, signed, id } = await contradiction('succeeded', changes);
    await publish(f, id, signed.raw); await expectBlocked(id, f);
  });
  it('confirmed failure cannot masquerade as normalized success', async () => {
    const { f, signed, id } = await contradiction('failed'); await publish(f, id, signed.raw); await expectBlocked(id, f);
  });
  it.each(['pending', 'requires_action', 'succeeded'])('refund.failed with contradictory raw %s retains review', async status => {
    const f = await trustedEvidenceFixture(db), signed = signedEvidence(f, { status, externalType: 'refund.failed' });
    const id = await storeOriginalInbox(db, signed); await publish(f, id, signed.raw); await expectBlocked(id, f);
  });
  it('pending unsupported labeling with financial data remains contradictory', async () => {
    const f = await trustedEvidenceFixture(db), signed = signedEvidence(f, { status: 'pending' });
    const id = await storeOriginalInbox(db, { ...signed, payload: { ...signed.payload, data: { providerTransactionId: f.objectId, amount: 5000, currency: 'EUR' } } });
    await publish(f, id, signed.raw); await expectBlocked(id, f);
  });
  it('duplicate contradiction preserves original receipt, review, obligation and revisions', async () => {
    const { f, signed, id, payload } = await contradiction(); await publish(f, id, signed.raw);
    const before = await obligation(id);
    await publish(f, id, signed.raw);
    await asRole(worker, tx => tx`select public.enroll_receipt_admission(${id},null)`);
    expect(await obligation(id)).toEqual(before); await expectBlocked(id, f);
    expect(await db.sql`select id from financial_evidence_reviews where inbox_id=${id}`).toHaveLength(1);
    const [receipt] = await db.sql<{ raw_body: Buffer; normalized_payload: unknown }[]>`select raw_body,normalized_payload from provider_financial_receipts where inbox_id=${id}`;
    expect(receipt.raw_body).toEqual(signed.raw); expect(receipt.normalized_payload).toEqual(payload);
  });
  it.each(['RETRY', 'DEAD'])('contradiction survives inbox %s and lease expiry', async status => {
    const { f, signed, id } = await contradiction(); await publish(f, id, signed.raw);
    const before = await obligation(id);
    await db.sql`update webhook_events set status=${status},attempts=attempts+1,locked_at=now()-interval '1 minute' where id=${id}`;
    expect(await obligation(id)).toEqual(before); await expectBlocked(id, f);
  });
  it('worker cannot directly clear contradiction or rewind authority', async () => {
    const { f, signed, id } = await contradiction(); await publish(f, id, signed.raw);
    const before = await obligation(id);
    await expect(asRole(worker, tx => tx`update receipt_admission_obligations set disposition='AWAITING_CONFIRMATION',review_id=null where inbox_id=${id}`)).rejects.toThrow(/permission denied/);
    await db.sql.unsafe(`grant select,update on capture_accounting_scopes,receipt_intake_authority to "${worker}"`);
    await expect(asRole(worker, tx => tx`update receipt_intake_authority set evidence_revision=0 where provider_account=${f.account}`)).rejects.toThrow(/guarded/);
    expect(await obligation(id)).toEqual(before); await expectBlocked(id, f);
    await expect(inspect(f, '0', '0')).rejects.toThrow(/Stale/);
  });
  it('unproven resolution and binding cannot clear contradictory evidence', async () => {
    const { f, signed, id } = await contradiction(); await publish(f, id, signed.raw);
    const before = await obligation(id);
    for (const kind of ['APPLICATION', 'NO_EFFECT']) await expect(asRole(worker,
      tx => tx`select public.resolve_receipt_obligation(${id},${kind},null)`)).rejects.toThrow(/Owned proof/);
    await expect(asRole(worker, tx => tx`select public.bind_receipt_obligation(${id},1)`)).rejects.toThrow();
    expect(await obligation(id)).toEqual(before); await expectBlocked(id, f);
  });
  it('failed replay transaction preserves the committed blocker', async () => {
    const { f, signed, id } = await contradiction(); await publish(f, id, signed.raw);
    const before = await obligation(id);
    await expect(asRole(worker, async tx => { await tx`select public.enroll_receipt_admission(${id},null)`; throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await obligation(id)).toEqual(before); await expectBlocked(id, f);
  });
  it('initial publication rollback is atomic and retry retains the required blocker', async () => {
    const { f, signed, id } = await contradiction();
    await expect(asRole(publisher, async tx => {
      await tx`select public.publish_admitted_receipt(${id},${f.account},${signed.raw},'isolated-SDK-fixture/v1')`;
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await obligation(id)).toBeUndefined();
    expect(await db.sql`select inbox_id from provider_financial_receipts where inbox_id=${id}`).toHaveLength(0);
    expect(await db.sql`select id from financial_evidence_reviews where inbox_id=${id}`).toHaveLength(0);
    expect(await inspect(f)).toHaveLength(1);
    await publish(f, id, signed.raw); await expectBlocked(id, f);
  });
  it('deferred classification check refuses a nonblocking obligation even under its capability owner', async () => {
    const { f, signed, id, payload } = await contradiction();
    await db.transaction(tx => publishVerifiedReceipt(tx, f, id, { ...signed, payload }));
    const [role] = await db.sql<{ name: string }[]>`select 'fintech_admission_'||md5(current_database()) as name`;
    await expect(asRole(role.name, async tx => {
      await tx`insert into receipt_intake_authority(provider,provider_account) values('STRIPE',${f.account})`;
      await tx`insert into receipt_admissions(inbox_id,provider,provider_account,contract_version,operation,financially_relevant)
        values(${id},'STRIPE',${f.account},1,'refund.pending',true)`;
      await tx`insert into receipt_admission_obligations(inbox_id,provider,provider_account,operation,disposition,intake_evidence_revision)
        values(${id},'STRIPE',${f.account},'refund.pending','AWAITING_CONFIRMATION',0)`;
    })).rejects.toThrow(/Contradictory admission requires retained blocking review/);
    expect(await obligation(id)).toBeUndefined(); expect(await inspect(f)).toHaveLength(1);
    await publish(f, id, signed.raw); await expectBlocked(id, f);
  });
  it('unknown review blocks its whole account without freezing another account', async () => {
    const { f, signed, id } = await contradiction(), sameAccount = await trustedEvidenceFixture(db, f.account);
    const unrelated = await trustedEvidenceFixture(db);
    await publish(f, id, signed.raw); await expectBlocked(id, f);
    await expect(inspect(sameAccount)).rejects.toThrow(/blocked/);
    expect(await inspect(unrelated)).toHaveLength(1);
    expect((await db.sql`select evidence_revision::text from capture_accounting_scopes where merchant_id=${sameAccount.merchantId}`)[0].evidence_revision).toBe('0');
  });
  it('nonfinancial unsupported customer evidence adds no blocker for either same-account scope', async () => {
    const f = await trustedEvidenceFixture(db), other = await trustedEvidenceFixture(db, f.account);
    const signed = signedEvidence(f, { externalType: 'customer.created', object: { object: 'customer', id: 'cus_isolated' } });
    const id = await storeOriginalInbox(db, signed); await publish(f, id, signed.raw);
    expect(await obligation(id)).toBeUndefined(); expect(await inspect(f)).toHaveLength(1); expect(await inspect(other)).toHaveLength(1);
    expect(await db.sql`select id from financial_evidence_reviews where inbox_id=${id}`).toHaveLength(0);
  });
});
