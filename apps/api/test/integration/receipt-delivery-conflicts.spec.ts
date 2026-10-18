import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import Stripe from 'stripe';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DatabaseService, type DbTransaction } from '../../src/database/database.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { CaptureRefundAccountingService } from '../../src/refunds/capture-refund-accounting.service';
import { normalizeStripeEvent } from '../../src/webhooks/stripe-event.normalizer';
import type { ProviderEvent } from '../../src/webhooks/webhook.types';
import { publishCommandObservation, publishVerifiedReceipt, signedEvidence, storeOriginalInbox, trustedEvidenceFixture } from '../support/trusted-evidence-fixtures';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Fixture = Awaited<ReturnType<typeof trustedEvidenceFixture>>;
type Original = { f: Fixture; id: string; signed: ReturnType<typeof signedEvidence> };
type Attempt = { raw: Buffer; signature: string; headers: Record<string, string>; payload: ProviderEvent };
class DormantRefund extends CaptureRefundAccountingService {
  protected assertActiveScope(status: string) { if (status !== 'FOUNDATION_ONLY') throw new Error('Expected dormant scope'); }
}

describeDatabase('R0.2 verified delivery SQL (SDK fixtures, not HTTP ingress)', () => {
  let db: DatabaseService, publisher: string, worker: string, owner: string;
  const stripe = new Stripe('sk_test_r02_isolated_fixture'), secret = 'whsec_r02_isolated_fixture';
  beforeAll(async () => {
    const value = process.env.MIGRATION_ADMIN_URL;
    if (!value) throw new Error('Disposable MIGRATION_ADMIN_URL required');
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local database required');
    const name = `fintech_r02_deliveries_${randomUUID().replaceAll('-', '')}`, admin = postgres(value, { max: 1 });
    try { await admin.unsafe(`create database "${name}"`); } finally { await admin.end(); }
    url.pathname = `/${name}`;
    const sql = postgres(url.toString(), { max: 1 });
    try { await migrate(drizzle(sql), { migrationsFolder: resolve(__dirname, '../../drizzle') }); } finally { await sql.end(); }
    db = new DatabaseService(new ConfigService({ DATABASE_URL: url.toString() }));
    const suffix = randomUUID().replaceAll('-', ''); publisher = `r02_pub_${suffix}`; worker = `r02_worker_${suffix}`;
    owner = (await db.sql<{ name: string }[]>`select 'fintech_admission_'||md5(current_database()) as name`)[0].name;
    for (const role of [publisher, worker]) {
      await db.sql.unsafe(`create role "${role}" nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls`);
      await db.sql.unsafe(`grant usage on schema public to "${role}"`);
    }
    await db.sql.unsafe(`grant execute on function public.publish_admitted_receipt(uuid,text,bytea,text),public.publish_verified_receipt_delivery(uuid,text,bytea,text,jsonb,jsonb,text) to "${publisher}"`);
    await db.sql.unsafe(`grant execute on function public.inspect_receipt_admission(text,text,uuid,text,bigint,bigint),public.enroll_receipt_admission(uuid,integer),public.bind_receipt_obligation(uuid,integer),public.resolve_receipt_obligation(uuid,text,uuid) to "${worker}"`);
    mkdirSync(resolve(__dirname, '../../../../.tmp'), { recursive: true });
    writeFileSync(resolve(__dirname, '../../../../.tmp/r02-delivery-db.txt'), name + '\n');
  }, 30000);
  afterAll(async () => {
    if (db) try {
      expect((await db.sql`select count(*)::int as n from capture_accounting_scopes where status='ACTIVE'`)[0].n).toBe(0);
      expect((await db.sql`select count(*)::int as n from financial_evidence_accounts where runtime_enforcement<>'UNINSTALLED'`)[0].n).toBe(0);
    } finally { await db.onApplicationShutdown(); }
  });
  const asRole = <T>(role: string, work: (tx: DbTransaction) => Promise<T>) => db.transaction(async tx => {
    await tx.unsafe(`set local role "${role}"`); return work(tx);
  });
  const inspect = (tx: DbTransaction, f: Fixture, scope: string | null = null, intake: string | null = null) =>
    tx`select * from public.inspect_receipt_admission('STRIPE',${f.account},${f.merchantId},'USD',${scope},${intake})`;
  const read = (f: Fixture, scope: string | null = null, intake: string | null = null) => asRole(worker, tx => inspect(tx, f, scope, intake));
  const barriers = (id: string) => db.sql`select * from receipt_delivery_barriers where delivery_id=${id} order by barrier_key`;
  const attempts = (o: Original) => db.sql`select * from receipt_delivery_attempts where original_inbox_id=${o.id} order by received_at,id`;
  const revisions = async (f: Fixture) => (await db.sql`select s.evidence_revision::text as scope,
    coalesce((select evidence_revision::text from receipt_intake_authority where provider='STRIPE' and provider_account=${f.account}),'0') as intake
    from capture_accounting_scopes s where merchant_id=${f.merchantId} and currency='USD'`)[0];
  async function original(kind: 'nonfinancial' | 'financial' | 'pending' = 'nonfinancial', known = false, account?: string): Promise<Original> {
    const f = await trustedEvidenceFixture(db, account);
    const signed = signedEvidence(f, kind === 'nonfinancial' ? { externalType: 'customer.created', object: { object: 'customer', id: `cus_${randomUUID()}` } } : kind === 'pending' ? { status: 'pending' } : {});
    const id = await storeOriginalInbox(db, signed);
    await asRole(publisher, tx => tx`select public.publish_admitted_receipt(${id},${f.account},${signed.raw},'isolated-SDK-fixture/v1')`);
    if (known) {
      await db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
      await db.sql`select public.seal_financial_correlation(${id},0)`;
      await asRole(worker, tx => tx`select public.bind_receipt_obligation(${id},1)`);
    }
    return { f, signed, id };
  }
  function sign(raw: Buffer, timestamp = Math.floor(Date.now() / 1000)): Attempt {
    const signature = stripe.webhooks.generateTestHeaderString({ payload: raw.toString('utf8'), secret, timestamp });
    const verified = stripe.webhooks.constructEvent(raw, signature, secret);
    return { raw, signature, headers: { 'stripe-signature': signature }, payload: normalizeStripeEvent(verified) };
  }
  function attempt(o: Original, changes?: Parameters<typeof signedEvidence>[1]): Attempt {
    if (changes === undefined) return sign(o.signed.raw);
    const next = signedEvidence(o.f, changes).event;
    return sign(Buffer.from(JSON.stringify({ ...next, id: o.signed.event.id, created: o.signed.event.created })));
  }
  const writeTx = (tx: DbTransaction, o: Original, a: Attempt, account = o.f.account) => tx<{ id: string; classification: string; review_id: string | null }[]>`
    select * from public.publish_verified_receipt_delivery(${o.id},${account},${a.raw},${a.signature},${tx.json(a.headers)},${tx.json(a.payload as never)},'isolated-SDK-fixture/v1')`;
  async function write(o: Original, a: Attempt, account = o.f.account) {
    // Local SDK authentication is an explicit test fixture boundary; SQL alone
    // cannot authenticate an HTTP request or a trusted capability holder's claim.
    stripe.webhooks.constructEvent(a.raw, a.signature, secret);
    return (await asRole(publisher, tx => writeTx(tx, o, a, account)))[0];
  }
  async function savedOriginal(o: Original) {
    return Promise.all([
      db.sql`select * from provider_financial_receipts where inbox_id=${o.id}`,
      db.sql`select * from receipt_admissions where inbox_id=${o.id}`,
      db.sql`select * from webhook_financial_evidence where inbox_id=${o.id}`,
      db.sql`select provider,provider_event_id,signature,headers,payload from webhook_events where id=${o.id}`,
    ]);
  }
  async function cleared(o: Original) {
    const service = new DormantRefund(db, new IdempotencyService(db), new OutboxService(), new AuditService(), new LedgerService(db));
    await db.transaction(tx => service.applySucceeded(tx, o.id));
    const [journal] = await db.sql<{ id: string }[]>`select id from ledger_transactions where business_type='REFUND' and business_id=${o.f.refundId}`;
    await asRole(worker, tx => tx`select public.resolve_receipt_obligation(${o.id},'APPLICATION',${journal.id})`);
    expect(await read(o.f)).toHaveLength(1);
  }
  async function waitFor(waiter: number, holder: number) {
    for (let i = 0; i < 200; i++) {
      if ((await db.sql<{ yes: boolean }[]>`select ${holder}=any(pg_blocking_pids(${waiter})) as yes`)[0].yes) return;
      await delay(20);
    }
    throw new Error('Expected PostgreSQL lock wait not observed');
  }
  async function schedule(firstRole: string, first: (tx: DbTransaction) => Promise<unknown>, secondRole: string, second: (tx: DbTransaction) => Promise<unknown>, rejection = false) {
    let release!: () => void, ready!: () => void, waiterReady!: () => void, holder = 0, waiter = 0;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { ready = r; }), waiting = new Promise<void>(r => { waiterReady = r; });
    const held = asRole(firstRole, async tx => { await tx`set local statement_timeout='10s'`; holder = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid; const result = await first(tx); ready(); await gate; return result; });
    let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
      await Promise.race([started, held]);
      pending = asRole(secondRole, async tx => { await tx`set local statement_timeout='10s'`; waiter = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid; waiterReady(); return second(tx); }).then(value => ({ value }), (error: unknown) => ({ error }));
      await waiting; expect(waiter).not.toBe(holder); await waitFor(waiter, holder); release(); await held;
      const result = await pending;
      if (rejection) expect(String(result.error)).toMatch(/blocked|Stale/); else expect(result.error).toBeUndefined();
    } finally { release(); await Promise.allSettled([held, ...(pending ? [pending] : [])]); }
  }

  it('exact replay returns one attempt without barriers or revisions', async () => {
    const o = await original(), a = attempt(o), before = await revisions(o.f), first = await write(o, a);
    expect(first.classification).toBe('EQUIVALENT'); expect(await write(o, a)).toEqual(first);
    expect(await attempts(o)).toHaveLength(1); expect(await barriers(first.id)).toHaveLength(0);
    expect(await revisions(o.f)).toEqual(before); expect(await read(o.f)).toHaveLength(1);
  });
  it('refreshed signature timestamp and transport headers preserve equivalent event semantics', async () => {
    const o = await original(), a = sign(o.signed.raw, Math.floor(Date.now() / 1000) - 1), b = sign(o.signed.raw);
    a.headers['x-request-id'] = 'first'; b.headers['x-request-id'] = 'second';
    const x = await write(o, a), y = await write(o, b);
    expect(x.id).not.toBe(y.id); expect(x.classification).toBe('EQUIVALENT'); expect(y.classification).toBe('EQUIVALENT');
    expect(await barriers(x.id)).toHaveLength(0); expect(await barriers(y.id)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1);
    expect(await revisions(o.f)).toMatchObject({ scope: '0', intake: '0' });
  });
  it('JSON whitespace is retained without manufacturing a financial conflict', async () => {
    const o = await original('pending'), a = sign(Buffer.from(JSON.stringify(o.signed.event, null, 2))), d = await write(o, a);
    expect(d.classification).toBe('EQUIVALENT'); expect(await barriers(d.id)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1);
  });
  it('nonfinancial original acquires an independent financial conflict barrier', async () => {
    const o = await original(), before = await savedOriginal(o), a = attempt(o, {}), d = await write(o, a);
    expect(d.classification).toBe('CONFLICT'); expect(await barriers(d.id)).toMatchObject([{ provider_account: o.f.account, merchant_id: null, disposition: 'BLOCKING_REVIEW', intake_evidence_revision: '1' }]);
    expect(await db.sql`select * from receipt_admission_obligations where inbox_id=${o.id}`).toHaveLength(0);
    expect(await savedOriginal(o)).toEqual(before); await expect(read(o.f)).rejects.toThrow(/blocked/);
    expect((await attempts(o))[0].raw_body).toEqual(a.raw);
  });
  it('later nonfinancial changes retain review evidence without unnecessary barriers', async () => {
    const o = await original(), d = await write(o, attempt(o, { externalType: 'customer.updated', object: { object: 'customer', id: 'cus_changed' } }));
    expect(d.classification).toBe('CONFLICT'); expect(d.review_id).not.toBeNull(); expect(await barriers(d.id)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1);
  });
  it('confirmed original and contradictory outcome retain one unknown-account barrier', async () => {
    const o = await original('financial'), before = await revisions(o.f), d = await write(o, attempt(o, { status: 'failed' }));
    expect(await barriers(d.id)).toMatchObject([{ merchant_id: null, provider_account: o.f.account }]);
    expect((await revisions(o.f)).intake).toBe(String(BigInt(String(before.intake)) + 1n)); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it('a cleared original cannot hide a new scoped conflict', async () => {
    const o = await original('financial', true); await cleared(o); const before = await revisions(o.f), snapshot = await savedOriginal(o);
    const d = await write(o, attempt(o, { status: 'failed' }));
    expect(await barriers(d.id)).toMatchObject([{ merchant_id: o.f.merchantId, currency: 'USD', provider_account: o.f.account }]);
    expect((await revisions(o.f)).scope).toBe(String(BigInt(String(before.scope)) + 1n));
    expect(await savedOriginal(o)).toEqual(snapshot); await expect(read(o.f)).rejects.toThrow(/blocked/);
    await expect(read(o.f, String(before.scope), String(before.intake))).rejects.toThrow(/Stale/);
  });
  it.each([
    ['amount', { amount: 4999 }], ['currency', { currency: 'eur' }], ['object', { id: 're_other' }],
    ['PI', { payment_intent: 'pi_other' }], ['Charge', { charge: 'ch_other' }],
    ['merchant', { metadata: { merchantId: randomUUID() } }], ['payment', { metadata: { paymentId: randomUUID() } }],
  ])('conflicting %s cannot borrow the original sealed scope', async (_label, object) => {
    const o = await original('financial', true), other = await trustedEvidenceFixture(db, o.f.account);
    expect(await read(other)).toHaveLength(1);
    const d = await write(o, attempt(o, { status: 'failed', object }));
    expect(await barriers(d.id)).toMatchObject([{ merchant_id: null, currency: null }]); await expect(read(other)).rejects.toThrow(/blocked/);
  });
  it('normalization conflict cannot use a raw nonfinancial exemption', async () => {
    const o = await original(), a = attempt(o);
    a.payload = { ...a.payload, type: 'refund.succeeded', data: { providerTransactionId: o.f.objectId, amount: 5000, currency: 'USD' } };
    const d = await write(o, a); expect(await barriers(d.id)).toHaveLength(1); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it('a wrong normalized owner forces account-level review', async () => {
    const o = await original('financial', true), a = attempt(o, { status: 'failed' });
    a.payload = { ...a.payload, data: { ...a.payload.data!, merchantId: randomUUID() } };
    const d = await write(o, a); expect(await barriers(d.id)).toMatchObject([{ merchant_id: null }]); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it('invalid signature is rejected by the explicit SDK fixture before SQL publication', async () => {
    const o = await original(), a = attempt(o, {}); a.signature = 't=1,v1=invalid';
    await expect(write(o, a)).rejects.toThrow(); expect(await attempts(o)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1);
  });
  it('ordinary role cannot invoke trusted publication or fabricate verified rows', async () => {
    const o = await original(), a = attempt(o, {});
    await expect(asRole(worker, tx => writeTx(tx, o, a))).rejects.toThrow(/permission denied/);
    await expect(asRole(worker, tx => tx`insert into receipt_delivery_attempts(id) values(${randomUUID()})`)).rejects.toThrow(/permission denied/);
    expect(await attempts(o)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1);
  });
  it('unconfigured account and mismatched signed claim cannot create barriers', async () => {
    const o = await original(), a = attempt(o, { providerAccount: 'acct_untrusted' });
    await expect(write(o, a)).rejects.toThrow(/trusted configured/);
    await expect(write(o, a, 'acct_unconfigured')).rejects.toThrow(/configured account/);
    expect(await attempts(o)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1);
  });
  it('independently trusted different account preserves the original and blocks only its financial side', async () => {
    const o = await original(), other = await trustedEvidenceFixture(db), third = await trustedEvidenceFixture(db), snapshot = await savedOriginal(o);
    const d = await write(o, attempt(o, { providerAccount: other.account }), other.account);
    expect(await barriers(d.id)).toMatchObject([{ provider_account: other.account, merchant_id: null }]);
    expect(await savedOriginal(o)).toEqual(snapshot); expect(await read(o.f)).toHaveLength(1); await expect(read(other)).rejects.toThrow(/blocked/); expect(await read(third)).toHaveLength(1);
  });
  it('two trusted financial accounts protect their separate established authorities', async () => {
    const o = await original('financial', true); await cleared(o); const other = await trustedEvidenceFixture(db);
    const d = await write(o, attempt(o, { providerAccount: other.account, status: 'failed' }), other.account);
    const rows = await barriers(d.id); expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ provider_account: o.f.account, merchant_id: o.f.merchantId }), expect.objectContaining({ provider_account: other.account, merchant_id: null })]));
    await expect(read(o.f)).rejects.toThrow(/blocked/); await expect(read(other)).rejects.toThrow(/blocked/);
  });
  it('distinct conflicts retain separate raw evidence and immutable review identities', async () => {
    const o = await original(), first = await write(o, attempt(o, { status: 'succeeded' })), second = await write(o, attempt(o, { status: 'failed' }));
    expect(first.id).not.toBe(second.id); expect(first.review_id).not.toBe(second.review_id); expect(await attempts(o)).toHaveLength(2);
    expect(await barriers(first.id)).toHaveLength(1); expect(await barriers(second.id)).toHaveLength(1); expect((await revisions(o.f)).intake).toBe('2'); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it('identical conflicting attempt returns original evidence without another revision', async () => {
    const o = await original(), a = attempt(o, {}), d = await write(o, a), before = await revisions(o.f);
    expect(await write(o, a)).toEqual(d); expect(await attempts(o)).toHaveLength(1); expect(await barriers(d.id)).toHaveLength(1); expect(await revisions(o.f)).toEqual(before); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it.each(['RETRY', 'DEAD', 'PROCESSED', 'IGNORED'])('legacy %s and expired lease do not clear the independent barrier', async status => {
    const o = await original(), d = await write(o, attempt(o, {})), before = await barriers(d.id);
    await db.sql`update webhook_events set status=${status},locked_at=now()-interval '1 minute' where id=${o.id}`;
    expect(await barriers(d.id)).toEqual(before); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it('ordinary role cannot clear barriers or reset either revision authority', async () => {
    const o = await original(), d = await write(o, attempt(o, {}));
    for (const work of [(tx: DbTransaction) => tx`delete from receipt_delivery_barriers where delivery_id=${d.id}`,
      (tx: DbTransaction) => tx`update receipt_intake_authority set evidence_revision=0 where provider_account=${o.f.account}`,
      (tx: DbTransaction) => tx`update capture_accounting_scopes set evidence_revision=0 where merchant_id=${o.f.merchantId}`]) await expect(asRole(worker, work)).rejects.toThrow(/permission denied/);
    expect(await barriers(d.id)).toHaveLength(1); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it.each(['update', 'delete', 'truncate'])('trusted database fixture cannot %s immutable conflict evidence', async action => {
    const o = await original(), d = await write(o, attempt(o, {}));
    for (const table of ['receipt_delivery_attempts', 'receipt_delivery_barriers']) {
      const query = action === 'update' ? `update public.${table} set provider=provider` : `${action} ${action === 'delete' ? 'from ' : ''}public.${table}${action === 'truncate' ? ' cascade' : ''}`;
      await expect(db.sql.unsafe(query)).rejects.toThrow(/immutable/);
    }
    expect(await barriers(d.id)).toHaveLength(1); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it('rollback after publication retains only the earlier conflict and revision', async () => {
    const o = await original(), first = await write(o, attempt(o, {})), before = await revisions(o.f), a = attempt(o, { status: 'failed' });
    await expect(asRole(publisher, async tx => { await writeTx(tx, o, a); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await attempts(o)).toHaveLength(1); expect(await barriers(first.id)).toHaveLength(1); expect(await revisions(o.f)).toEqual(before); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it('failure between attempt and barrier insertion rolls the complete publication back', async () => {
    const o = await original(), a = attempt(o, {});
    await expect(asRole(publisher, async tx => { await tx`set constraints all immediate`; await writeTx(tx, o, a); })).rejects.toThrow(/exact atomic barrier set/);
    expect(await attempts(o)).toHaveLength(0); expect(await revisions(o.f)).toMatchObject({ scope: '0', intake: '0' }); expect(await read(o.f)).toHaveLength(1);
  });
  it.each([false, true])('deferred commit rejects evidence missing its required barrier, known=%s', async known => {
    const o = await original(known ? 'financial' : 'nonfinancial', known);
    if (known) await cleared(o);
    const a = attempt(o, { status: 'failed' }), id = randomUUID(), review = randomUUID(), before = await revisions(o.f);
    await expect(asRole(owner, async tx => {
      const [row] = await tx<{ facts: { reason: string; operation: string; relevant: boolean } }[]>`select public.receipt_delivery_facts(
        ${o.id},${o.f.account},${a.raw},${tx.json(a.payload as never)},${known ? 1 : null}) as facts`;
      await tx`insert into financial_evidence_reviews(id,inbox_id,review_key,reason,observations)
        values(${review},${o.id},${'receipt-delivery/' + id},'CONTRADICTORY',${tx.json({ contract: 'R0_2', delivery_id: id,
          reason: row.facts.reason, original_account: o.f.account, delivery_account: o.f.account })})`;
      await tx`insert into receipt_delivery_attempts(id,original_inbox_id,provider,provider_event_id,original_account,provider_account,
        delivery_key,raw_body,signature,headers,normalized_payload,normalization_version,verification_method,verification_version,
        original_proof_revision,classification,reason,operation,financially_relevant,review_id)
        values(${id},${o.id},'STRIPE',${o.signed.event.id},${o.f.account},${o.f.account},
          sha256(convert_to(jsonb_build_array(${o.f.account}::text,encode(${a.raw},'hex'),${a.signature}::text,
            ${tx.json(a.headers)},${tx.json(a.payload as never)},1,'isolated-SDK-fixture/v1')::text,'UTF8')),
          ${a.raw},${a.signature},${tx.json(a.headers)},${tx.json(a.payload as never)},1,'STRIPE_SDK','isolated-SDK-fixture/v1',
          ${known ? 1 : null},'CONFLICT',${row.facts.reason},${row.facts.operation},${row.facts.relevant},${review})`;
      // Deliberately return normally: the deferred constraint must reject COMMIT.
    })).rejects.toThrow(/exact atomic barrier set/);
    expect(await attempts(o)).toHaveLength(0); expect(await db.sql`select id from financial_evidence_reviews where id=${review}`).toHaveLength(0);
    expect(await revisions(o.f)).toEqual(before); expect(await read(o.f)).toHaveLength(1);
  });
  it('deferred classification rejects a contradictory row incorrectly labelled equivalent', async () => {
    const o = await original(), a = attempt(o, {});
    await expect(asRole(owner, tx => tx`insert into receipt_delivery_attempts(original_inbox_id,provider,provider_event_id,original_account,provider_account,
      delivery_key,raw_body,signature,headers,normalized_payload,normalization_version,verification_method,verification_version,
      classification,reason,operation,financially_relevant)
      values(${o.id},'STRIPE',${o.signed.event.id},${o.f.account},${o.f.account},
        sha256(convert_to(jsonb_build_array(${o.f.account}::text,encode(${a.raw},'hex'),${a.signature}::text,
          ${tx.json(a.headers)},${tx.json(a.payload as never)},1,'isolated-SDK-fixture/v1')::text,'UTF8')),
        ${a.raw},${a.signature},${tx.json(a.headers)},${tx.json(a.payload as never)},1,'STRIPE_SDK','isolated-SDK-fixture/v1',
        'EQUIVALENT','EQUIVALENT_EVENT_FACTS','provider.unrelated',false)`)).rejects.toThrow(/classification/);
    expect(await attempts(o)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1);
  });
  it('barrier without matching evidence cannot commit even under the non-login owner', async () => {
    const o = await original();
    await expect(asRole(owner, tx => tx`insert into receipt_delivery_barriers(delivery_id,barrier_key,provider,provider_account,review_id,intake_evidence_revision)
      values(${randomUUID()},'fabricated','STRIPE',${o.f.account},${randomUUID()},1)`)).rejects.toThrow(/foreign key/);
    expect(await attempts(o)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1);
  });
  it('extra barrier for an equivalent attempt fails the derived-set constraint', async () => {
    const o = await original(), d = await write(o, attempt(o));
    const [review] = await db.sql<{ id: string }[]>`insert into financial_evidence_reviews(inbox_id,review_key,reason,observations) values(${o.id},${randomUUID()},'CONTRADICTORY','{}') returning id`;
    await expect(asRole(owner, tx => tx`insert into receipt_delivery_barriers(delivery_id,barrier_key,provider,provider_account,review_id,intake_evidence_revision)
      values(${d.id},'fabricated','STRIPE',${o.f.account},${review.id},1)`)).rejects.toThrow(/exact atomic barrier set/);
    expect(await barriers(d.id)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1);
  });
  it('arbitrary review notes cannot clear conflict, and R0 resolution cannot resolve a nonfinancial original', async () => {
    const o = await original(), d = await write(o, attempt(o, {}));
    await db.sql`insert into financial_evidence_reviews(inbox_id,review_key,reason,observations) values(${o.id},${randomUUID()},'UNRESOLVED','{"note":"resolved"}')`;
    await expect(asRole(worker, tx => tx`select public.resolve_receipt_obligation(${o.id},'NO_EFFECT',null)`)).rejects.toThrow();
    expect(await barriers(d.id)).toMatchObject([{ disposition: 'BLOCKING_REVIEW' }]); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it('stored clearance revisions reject after conflict publication', async () => {
    const o = await original(), [before] = await read(o.f); await write(o, attempt(o, {}));
    await expect(read(o.f, String(before.scope_revision), String(before.intake_revision))).rejects.toThrow(/Stale/); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it.each(['pending', 'requires_action'])('equivalent %s retry preserves Option A without a journal', async status => {
    const o = await original('pending'), a = status === 'pending' ? attempt(o) : attempt(o, { status });
    if (status === 'requires_action') {
      // Same pending state is a different signed fact: use its own original.
      const f = await trustedEvidenceFixture(db), signed = signedEvidence(f, { status }), id = await storeOriginalInbox(db, signed);
      await asRole(publisher, tx => tx`select public.publish_admitted_receipt(${id},${f.account},${signed.raw},'isolated-SDK-fixture/v1')`);
      const own = { f, signed, id }, d = await write(own, attempt(own)); expect(await barriers(d.id)).toHaveLength(0); expect(await read(f)).toHaveLength(1);
    } else { const d = await write(o, a); expect(await barriers(d.id)).toHaveLength(0); expect(await read(o.f)).toHaveLength(1); }
    expect(await db.sql`select id from ledger_transactions where business_type='REFUND' and business_id=${o.f.refundId}`).toHaveLength(0);
  });
  it('unknown frozen attempt is not silently narrowed by later correlation', async () => {
    const o = await original('financial'), a = attempt(o, { status: 'failed' }), d = await write(o, a);
    await db.transaction(tx => publishCommandObservation(tx, o.f, 'CAPTURE')); await db.sql`select public.seal_financial_correlation(${o.id},0)`;
    await asRole(worker, tx => tx`select public.bind_receipt_obligation(${o.id},1)`);
    expect(await write(o, a)).toEqual(d); expect((await attempts(o))[0].original_proof_revision).toBeNull(); expect(await barriers(d.id)).toMatchObject([{ merchant_id: null }]); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it('same conflicting delivery serializes to one immutable witness and barrier', async () => {
    const o = await original(), a = attempt(o, {});
    await schedule(publisher, tx => writeTx(tx, o, a), publisher, tx => writeTx(tx, o, a));
    expect(await attempts(o)).toHaveLength(1); const [d] = await attempts(o); expect(await barriers(String(d.id))).toHaveLength(1); expect((await revisions(o.f)).intake).toBe('1'); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it.each([false, true])('equivalent/conflict acquisition order reversed=%s cannot erase the blocker', async reversed => {
    const o = await original(), same = attempt(o), conflict = attempt(o, {});
    await schedule(publisher, tx => writeTx(tx, o, reversed ? conflict : same), publisher, tx => writeTx(tx, o, reversed ? same : conflict));
    expect(await attempts(o)).toHaveLength(2); expect((await revisions(o.f)).intake).toBe('1'); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it.each([false, true])('conflict/reader acquisition order reversed=%s shares original authority', async reversed => {
    const o = await original(), a = attempt(o, {}), [before] = await read(o.f);
    if (reversed) await schedule(worker, tx => inspect(tx, o.f), publisher, tx => writeTx(tx, o, a));
    else await schedule(publisher, tx => writeTx(tx, o, a), worker, tx => inspect(tx, o.f), true);
    const [d] = await attempts(o); expect(await barriers(String(d.id))).toHaveLength(1); await expect(read(o.f)).rejects.toThrow(/blocked/);
    await expect(read(o.f, String(before.scope_revision), String(before.intake_revision))).rejects.toThrow(/Stale/);
  });
  it.each([false, true])('conflict/scoped R0 admission order reversed=%s preserves both revisions', async reversed => {
    const o = await original('financial', true), a = attempt(o, { status: 'failed' }), signed = signedEvidence(o.f), otherId = await storeOriginalInbox(db, signed);
    await db.transaction(tx => publishVerifiedReceipt(tx, o.f, otherId, signed)); await db.sql`select public.seal_financial_correlation(${otherId},0)`;
    const before = await revisions(o.f), admit = (tx: DbTransaction) => tx`select public.enroll_receipt_admission(${otherId},1)`;
    if (reversed) await schedule(worker, admit, publisher, tx => writeTx(tx, o, a)); else await schedule(publisher, tx => writeTx(tx, o, a), worker, admit);
    expect((await revisions(o.f)).scope).toBe(String(BigInt(String(before.scope)) + 2n)); const [d] = await attempts(o); expect(await barriers(String(d.id))).toMatchObject([{ merchant_id: o.f.merchantId }]); await expect(read(o.f)).rejects.toThrow(/blocked/);
  });
  it.each([false, true])('scoped conflict/other-account pooled reader order reversed=%s shares scope authority', async reversed => {
    const o = await original('financial', true); await cleared(o);
    const other = await trustedEvidenceFixture(db), pooled = { ...o.f, account: other.account }, a = attempt(o, { status: 'failed' });
    expect(await read(pooled)).toHaveLength(1);
    if (reversed) await schedule(worker, tx => inspect(tx, pooled), publisher, tx => writeTx(tx, o, a));
    else await schedule(publisher, tx => writeTx(tx, o, a), worker, tx => inspect(tx, pooled), true);
    const [d] = await attempts(o); expect(await barriers(String(d.id))).toMatchObject([{ merchant_id: o.f.merchantId }]);
    await expect(read(pooled)).rejects.toThrow(/blocked/); expect(await read(other)).toHaveLength(1);
  });
  it.each([false, true])('unknown barrier/other known scope reversed=%s cannot expose an account gap', async reversed => {
    const o = await original(), other = await original('financial', true, o.f.account), signed = signedEvidence(other.f), id = await storeOriginalInbox(db, signed);
    await db.transaction(tx => publishVerifiedReceipt(tx, other.f, id, signed)); await db.sql`select public.seal_financial_correlation(${id},0)`;
    const a = attempt(o, {}), admit = (tx: DbTransaction) => tx`select public.enroll_receipt_admission(${id},1)`;
    if (reversed) await schedule(worker, admit, publisher, tx => writeTx(tx, o, a)); else await schedule(publisher, tx => writeTx(tx, o, a), worker, admit);
    const [d] = await attempts(o); expect(await barriers(String(d.id))).toMatchObject([{ merchant_id: null }]); await expect(read(other.f)).rejects.toThrow(/blocked/);
  });
  it.each([false, true])('cross-account conflict order reversed=%s takes account locks canonically', async reversed => {
    const one = await original(), two = await original(), a = attempt(one, { providerAccount: two.f.account }), b = attempt(two, { providerAccount: one.f.account });
    const first = (tx: DbTransaction) => writeTx(tx, one, a, two.f.account), second = (tx: DbTransaction) => writeTx(tx, two, b, one.f.account);
    await schedule(publisher, reversed ? second : first, publisher, reversed ? first : second);
    expect(await attempts(one)).toHaveLength(1); expect(await attempts(two)).toHaveLength(1); await expect(read(one.f)).rejects.toThrow(/blocked/); await expect(read(two.f)).rejects.toThrow(/blocked/);
  });
});
