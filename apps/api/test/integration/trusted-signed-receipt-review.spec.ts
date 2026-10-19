import { setTimeout as delay } from 'node:timers/promises';
import type { DbTransaction } from '../../src/database/database.service';
import type { ReceiptTransactions } from '../../src/webhooks/trusted-receipt-database';
import { TrustedSignedReceiptService } from '../../src/webhooks/trusted-signed-receipt.service';
import { trustedReceiptHarness } from '../support/trusted-receipt-harness';
import { publishCommandObservation, signedEvidence, trustedEvidenceFixture, type EvidenceFixture } from '../support/trusted-evidence-fixtures';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(15000);
type Harness = Awaited<ReturnType<typeof trustedReceiptHarness>>;

describeDatabase('R1 independent receipt trust, rollback and recovery regressions', () => {
  let h: Harness;
  beforeAll(async () => { h = await trustedReceiptHarness(); }, 30000);
  afterAll(async () => { if (h) await h.close(); });
  const fixture = () => trustedEvidenceFixture(h.db);
  const deliver = (f: EvidenceFixture, signed = signedEvidence(f), database: ReceiptTransactions = h.publication) =>
    h.receiver(f.account, database).receive(signed.raw, signed.signature);
  const proof = (id: string) => h.db.sql`select * from webhook_financial_evidence where inbox_id=${id}`;
  const obligation = (id: string) => h.db.sql`select * from receipt_admission_obligations where inbox_id=${id}`;
  const revisions = async (f: EvidenceFixture) => (await h.db.sql`select evidence_revision::text as scope,
    coalesce((select evidence_revision::text from receipt_intake_authority where provider='STRIPE' and provider_account=${f.account}),'0') as intake
    from capture_accounting_scopes where merchant_id=${f.merchantId} and currency='USD'`)[0];

  it('SDK authentication precedes the database even when caller headers claim verification', async () => {
    const f = await fixture(), signed = signedEvidence(f);
    let calls = 0;
    const database: ReceiptTransactions = { transaction(work) { calls++; return h.publication.transaction(work); } };
    await expect(h.receiver(f.account, database).receive(signed.raw, 't=1,v1=forged', { verified: 'true' }))
      .rejects.toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
    expect(calls).toBe(0);
    expect(await h.db.sql`select id from webhook_events where provider_event_id=${signed.event.id}`).toHaveLength(0);
    expect(await revisions(f)).toEqual({ scope: '0', intake: '0' });
  });

  it('copies endpoint configuration, raw bytes and nested header arrays before asynchronous publication', async () => {
    const f = await fixture(), signed = signedEvidence(f), raw = Buffer.from(signed.raw);
    const endpoint = { account: f.account, webhookSecret: h.secret };
    const headers = { 'stripe-signature': signed.signature, 'x-review-array': ['original'] };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const database: ReceiptTransactions = { async transaction(work) { await gate; return h.publication.transaction(work); } };
    const receiver = new TrustedSignedReceiptService(database, endpoint, h.stripe);
    endpoint.account = 'acct_changed_after_construction'; endpoint.webhookSecret = 'whsec_changed_after_construction';
    const pending = receiver.receive(raw, signed.signature, headers);
    raw.fill(0); headers['x-review-array'][0] = 'changed'; headers['stripe-signature'] = 'changed'; release();
    const result = await pending;
    expect(await h.db.sql`select raw_body,headers,provider_account from provider_financial_receipts where inbox_id=${result.id}`)
      .toMatchObject([{ raw_body: signed.raw, provider_account: f.account,
        headers: { 'stripe-signature': signed.signature, 'x-review-array': ['original'] } }]);
  });

  it.each(['receipt_admissions', 'receipt_admission_obligations'])('failure before INSERT into %s rolls back the original inbox and prior evidence', async table => {
    const f = await fixture(), signed = signedEvidence(f), send = await h.http(h.receiver(f.account));
    await h.db.sql`create or replace function public.r1_review_abort() returns trigger language plpgsql as
      $$ begin raise exception 'independent publication abort'; end $$`;
    await h.db.sql.unsafe(`create trigger r1_review_abort before insert on public.${table} for each row execute function public.r1_review_abort()`);
    try { await send(signed).expect(500); }
    finally { await h.db.sql.unsafe(`drop trigger r1_review_abort on public.${table}`); }
    expect(await h.db.sql`select id from webhook_events where provider_event_id=${signed.event.id}`).toHaveLength(0);
    expect(await h.db.sql`select inbox_id from provider_financial_receipts where normalized_payload->>'id'=${signed.event.id}`).toHaveLength(0);
    expect(await h.db.sql`select inbox_id from receipt_admissions where provider_account=${f.account}`).toHaveLength(0);
    expect(await h.db.sql`select inbox_id from receipt_admission_obligations where provider_account=${f.account}`).toHaveLength(0);
    expect(await revisions(f)).toEqual({ scope: '0', intake: '0' });
    expect(await h.read(f)).toHaveLength(1);
    const response = await send(signed).expect(202);
    expect(await obligation(String(response.body.id))).toHaveLength(1);
  });

  it('later canonical test evidence permits retry without replacing the original unresolved receipt', async () => {
    const f = await fixture(), signed = signedEvidence(f, { metadata: {} }), result = await deliver(f, signed);
    const saved = await h.db.sql`select * from provider_financial_receipts where inbox_id=${result.id}`;
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'UNRESOLVED' });
    await expect(h.read(f)).rejects.toThrow(/blocked/);
    // Explicit synthetic D02 fixtures exercise existing trusted evidence only;
    // these are synthetic test sources, not results from a live provider.
    await h.db.transaction(async tx => { await publishCommandObservation(tx, f, 'CAPTURE'); await publishCommandObservation(tx, f, 'REFUND'); });
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'BOUND', proofRevision: 1 });
    expect(await h.db.sql`select * from provider_financial_receipts where inbox_id=${result.id}`).toEqual(saved);
    expect(await h.db.sql`select reason from financial_evidence_reviews where inbox_id=${result.id}`).toMatchObject([{ reason: 'UNRESOLVED' }]);
    expect(await obligation(result.id)).toMatchObject([{ disposition: 'AWAITING_APPLICATION', merchant_id: f.merchantId }]);
    expect(await revisions(f)).toEqual({ scope: '1', intake: '2' });
    await expect(h.read(f)).rejects.toThrow(/blocked/);
  });

  function interruptCorrelation(afterTransaction: number) {
    let calls = 0;
    const database: ReceiptTransactions = { transaction(work) {
      calls++;
      return h.correlation.transaction(async tx => {
        const result = await work(tx);
        if (calls === afterTransaction) await tx`do $$ begin raise exception 'independent interrupted correlation' using errcode='XX000'; end $$`;
        return result;
      });
    } };
    return database;
  }
  it.each([1, 2])('interruption before correlation transaction %s commits preserves a blocking obligation and allows fresh retry', async transaction => {
    const f = await fixture(); await h.db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
    const result = await deliver(f), before = await revisions(f);
    await expect(h.correlate(f.account, interruptCorrelation(transaction)).correlate(result.id)).rejects.toMatchObject({ code: 'XX000' });
    expect(await proof(result.id)).toHaveLength(transaction === 1 ? 0 : 1);
    expect(await h.db.sql`select id from provider_financial_object_owners where provider_account=${f.account}`).toHaveLength(transaction === 1 ? 0 : 1);
    expect(await obligation(result.id)).toMatchObject([{ disposition: 'AWAITING_CORRELATION', merchant_id: null }]);
    expect(await revisions(f)).toEqual(before); await expect(h.read(f)).rejects.toThrow(/blocked/);
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'BOUND' });
    expect(await proof(result.id)).toHaveLength(1); expect(await revisions(f)).toEqual({ scope: '1', intake: '2' });
    await expect(h.read(f)).rejects.toThrow(/blocked/);
  });

  it.each([
    { payment_intent: 'pi_wrong_review_relationship' },
    { charge: 'ch_wrong_review_relationship' },
    { id: 'dp_wrong_refund_object_kind' },
  ])('signed unsupported provider relationship %j cannot seal ownership', async object => {
    const f = await fixture(); await h.db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
    const result = await deliver(f, signedEvidence(f, { object }));
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'UNRESOLVED' });
    expect(await proof(result.id)).toHaveLength(0);
    expect(await obligation(result.id)).toMatchObject([{ merchant_id: null, disposition: 'AWAITING_CORRELATION' }]);
    await expect(h.read(f)).rejects.toThrow(/blocked/);
  });

  async function observeWait(holder: number, waiter: number) {
    expect(holder).not.toBe(waiter);
    for (let i = 0; i < 200; i++) {
      if ((await h.db.sql<{ waiting: boolean }[]>`select ${holder}=any(pg_blocking_pids(${waiter})) as waiting`)[0].waiting) return;
      await delay(20);
    }
    throw new Error('Expected controlled PostgreSQL wait was not observed');
  }
  function gated(base: ReceiptTransactions) {
    let release!: () => void, ready!: () => void, holder = 0, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { ready = resolve; });
    const database: ReceiptTransactions = { transaction<T>(work: (tx: DbTransaction) => Promise<T>) {
      return base.transaction(async tx => {
        const pause = !entered; entered = true;
        if (pause) holder = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid;
        const result = await work(tx);
        if (pause) { ready(); await gate; }
        return result;
      });
    } };
    return { database, started, release: () => release(), holder: () => holder };
  }
  it('two concurrent fresh correlation attempts seal and bind one proof without duplicate revisions', async () => {
    const f = await fixture(); await h.db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
    const result = await deliver(f), pause = gated(h.correlation);
    const first = h.correlate(f.account, pause.database).correlate(result.id);
    let second: ReturnType<ReturnType<Harness['correlate']>['correlate']> | undefined;
    try {
      await Promise.race([pause.started, first]);
      const waiter = (await h.correlationPeer<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid;
      second = h.correlate(f.account, h.peerCorrelation).correlate(result.id);
      await observeWait(pause.holder(), waiter); pause.release();
      expect(await first).toMatchObject({ state: 'BOUND' }); expect(await second).toMatchObject({ state: 'BOUND' });
      expect(await proof(result.id)).toHaveLength(1); expect(await obligation(result.id)).toHaveLength(1);
      expect(await revisions(f)).toEqual({ scope: '1', intake: '2' });
    } finally { pause.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
  it.each([false, true])('first delivery versus refreshed equivalent replay, reversed=%s, remains neutral', async reversed => {
    const f = await fixture(), signed = signedEvidence(f);
    const refreshed = h.sign(signed.raw, Math.floor(Date.now() / 1000) - 1);
    const one = reversed ? refreshed : signed, two = reversed ? signed : refreshed, pause = gated(h.publication);
    const first = h.receiver(f.account, pause.database).receive(one.raw, one.signature);
    let second: ReturnType<TrustedSignedReceiptService['receive']> | undefined;
    try {
      await Promise.race([pause.started, first]);
      const waiter = (await h.peer<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid;
      second = h.receiver(f.account, h.peerPublication).receive(two.raw, two.signature);
      await observeWait(pause.holder(), waiter); pause.release();
      const original = await first, retry = await second;
      expect(retry).toMatchObject({ id: original.id, duplicate: true, classification: 'EQUIVALENT' });
      expect(await h.db.sql`select delivery_id from receipt_delivery_barriers where delivery_id=${retry.deliveryId!}`).toHaveLength(0);
      expect(await obligation(original.id)).toHaveLength(1); expect(await revisions(f)).toEqual({ scope: '0', intake: '1' });
    } finally { pause.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
  it.each([false, true])('a rolled-back first delivery cannot become the original ahead of its waiting contender, reversed=%s', async reversed => {
    const f = await fixture(), financial = signedEvidence(f), event = { ...financial.event, type: 'customer.created' };
    const neutral = h.sign(Buffer.from(JSON.stringify(event))), one = reversed ? financial : neutral, two = reversed ? neutral : financial;
    const abort: ReceiptTransactions = { transaction(work) {
      return h.publication.transaction(async tx => {
        await work(tx);
        await tx`do $$ begin raise exception 'independent rolled-back first delivery' using errcode='XX000'; end $$`;
        throw new Error('SQL abort must not return');
      });
    } };
    // Pause after the first complete publication, before its injected abort.
    let release!: () => void, ready!: () => void, holder = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { ready = resolve; });
    const database: ReceiptTransactions = { transaction(work) {
      return abort.transaction(async tx => {
        holder = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid;
        const result = await work(tx); ready(); await gate; return result;
      });
    } };
    const first = h.receiver(f.account, database).receive(one.raw, one.signature).then(result => ({ result }), (error: unknown) => ({ error }));
    let second: ReturnType<TrustedSignedReceiptService['receive']> | undefined;
    try {
      await Promise.race([started, first]);
      const waiter = (await h.peer<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid;
      second = h.receiver(f.account, h.peerPublication).receive(two.raw, two.signature);
      await observeWait(holder, waiter); release();
      expect(await first).toMatchObject({ error: { code: 'XX000' } });
      const result = await second; expect(result).toMatchObject({ duplicate: false, classification: 'ORIGINAL' });
      expect(await h.db.sql`select raw_body from provider_financial_receipts where inbox_id=${result.id}`).toMatchObject([{ raw_body: two.raw }]);
      expect(await obligation(result.id)).toHaveLength(reversed ? 0 : 1);
      expect(await h.db.sql`select id from receipt_delivery_attempts where original_inbox_id=${result.id}`).toHaveLength(0);
      expect(await revisions(f)).toEqual({ scope: '0', intake: reversed ? '0' : '1' });
      if (reversed) expect(await h.read(f)).toHaveLength(1); else await expect(h.read(f)).rejects.toThrow(/blocked/);
    } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
});
