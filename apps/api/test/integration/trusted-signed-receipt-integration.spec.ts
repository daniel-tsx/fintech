import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sql } from 'postgres';
import { RestrictedReceiptDatabase, type ReceiptTransactions } from '../../src/webhooks/trusted-receipt-database';
import type { DbTransaction } from '../../src/database/database.service';
import { trustedReceiptHarness } from '../support/trusted-receipt-harness';
import { publishCommandObservation, signedEvidence, storeOriginalInbox, trustedEvidenceFixture, type EvidenceFixture } from '../support/trusted-evidence-fixtures';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(15000);
type Harness = Awaited<ReturnType<typeof trustedReceiptHarness>>;
type Signed = { raw: Buffer; signature: string };
describeDatabase('R1 isolated signed HTTP, receipt publication and correlation (no financial application)', () => {
  let h: Harness;
  beforeAll(async () => { h = await trustedReceiptHarness(); }, 30000);
  afterAll(async () => { if (h) await h.close(); });
  const fixture = (account?: string) => trustedEvidenceFixture(h.db, account);
  const neutral = (f: EvidenceFixture) => signedEvidence(f, { externalType: 'customer.created', object: { object: 'customer', id: `cus_${randomUUID()}` } });
  const changed = (original: ReturnType<typeof signedEvidence>, f: EvidenceFixture, options: Parameters<typeof signedEvidence>[1] = {}) => {
    const event = signedEvidence(f, options).event;
    return h.sign(Buffer.from(JSON.stringify({ ...event, id: original.event.id, created: original.event.created })));
  };
  const deliver = (f: EvidenceFixture, signed: Signed, database: ReceiptTransactions = h.publication) =>
    h.receiver(f.account, database).receive(signed.raw, signed.signature, { 'stripe-signature': signed.signature });
  const inbox = (eventId: string) => h.db.sql`select * from webhook_events where provider='STRIPE' and provider_event_id=${eventId}`;
  const original = (id: string) => Promise.all([
    h.db.sql`select * from provider_financial_receipts where inbox_id=${id}`, h.db.sql`select * from receipt_admissions where inbox_id=${id}`,
    h.db.sql`select * from webhook_financial_evidence where inbox_id=${id}`,
  ]);
  const obligations = (id: string) => h.db.sql`select * from receipt_admission_obligations where inbox_id=${id}`;
  const attempts = (id: string) => h.db.sql`select * from receipt_delivery_attempts where original_inbox_id=${id}`;
  const barriers = (id: string) => h.db.sql`select * from receipt_delivery_barriers b join receipt_delivery_attempts d on d.id=b.delivery_id where d.original_inbox_id=${id}`;
  const revisions = async (f: EvidenceFixture) => (await h.db.sql`select evidence_revision::text as scope,
    coalesce((select evidence_revision::text from receipt_intake_authority where provider='STRIPE' and provider_account=${f.account}),'0') as intake
    from capture_accounting_scopes where merchant_id=${f.merchantId} and currency='USD'`)[0];
  const proofs = (id: string) => h.db.sql`select * from webhook_financial_evidence where inbox_id=${id}`;
  const journals = (f: EvidenceFixture) => h.db.sql`select * from ledger_transactions where merchant_id=${f.merchantId} order by id`;

  it('valid signed HTTP atomically retains original/admission/one unknown obligation, without financial effects', async () => {
    const f = await fixture(), signed = signedEvidence(f), send = await h.http(h.receiver(f.account)), before = await journals(f);
    const response = await send(signed).expect(202), id = String(response.body.id);
    expect(response.body).toMatchObject({ duplicate: false, classification: 'ORIGINAL' });
    expect(await inbox(signed.event.id)).toHaveLength(1); const [receipt, admission] = await original(id);
    expect(receipt).toMatchObject([{ raw_body: signed.raw, provider_account: f.account, signature: signed.signature, normalization_version: 1 }]);
    expect(String(receipt[0].verification_version)).toMatch(/^stripe-node\/.*;R1_RECEIPT_V1$/);
    expect(admission).toMatchObject([{ financially_relevant: true, operation: 'refund.succeeded' }]);
    expect(await obligations(id)).toMatchObject([{ disposition: 'AWAITING_CORRELATION', merchant_id: null }]);
    expect(await revisions(f)).toEqual({ scope: '0', intake: '1' }); await expect(h.read(f)).rejects.toThrow(/blocked/);
    expect(await journals(f)).toEqual(before); expect(JSON.stringify(response.body)).not.toMatch(/raw_body|signature|whsec_|normalized_payload/);
  });
  it.each(['invalid', 'modified', 'expired', 'wrong-secret'])('HTTP %s signature cannot create an inbox or blocker', async kind => {
    const f = await fixture(), base = signedEvidence(f), send = await h.http(h.receiver(f.account));
    const signed = kind === 'expired' ? h.sign(base.raw, Math.floor(Date.now() / 1000) - 3600) : kind === 'wrong-secret' ? h.sign(base.raw, undefined, 'whsec_wrong_fixture') : { ...base };
    if (kind === 'invalid') signed.signature = 't=1,v1=invalid';
    if (kind === 'modified') signed.raw = Buffer.from(base.raw.toString('utf8') + ' ');
    await send(signed).expect(400); expect(await inbox(base.event.id)).toHaveLength(0); expect(await revisions(f)).toEqual({ scope: '0', intake: '0' }); expect(await h.read(f)).toHaveLength(1);
  });
  it('HTTP preserves exact formatted UTF8 bytes and request headers', async () => {
    const f = await fixture(), base = neutral(f), raw = Buffer.from(JSON.stringify({ ...base.event, description: 'Receipt € café' }, null, 2)), signed = h.sign(raw);
    const send = await h.http(h.receiver(f.account)), { body } = await send(signed, { 'x-fixture-evidence': 'retained' }).expect(202);
    const [receipt] = (await original(String(body.id)))[0];
    expect(receipt.raw_body).toEqual(raw); expect(receipt.headers).toMatchObject({ 'x-fixture-evidence': 'retained', 'stripe-signature': signed.signature });
    expect(await obligations(String(body.id))).toHaveLength(0); expect(await h.read(f)).toHaveLength(1);
  });
  it('missing raw capture is rejected through the isolated HTTP controller', async () => {
    const f = await fixture(), signed = signedEvidence(f), send = await h.http(h.receiver(f.account), false);
    const { body } = await send(signed).expect(400); expect(body.error?.code).toBe('RAW_BODY_REQUIRED'); expect(await inbox(signed.event.id)).toHaveLength(0);
  });
  it('signed account mismatching the server endpoint is rejected before SQL', async () => {
    const f = await fixture(), signed = signedEvidence(f, { providerAccount: 'acct_other' }), send = await h.http(h.receiver(f.account));
    await send(signed).expect(400); expect(await inbox(signed.event.id)).toHaveLength(0); expect(await h.read(f)).toHaveLength(1);
  });
  it('HTTP headers and owner metadata cannot select account authority', async () => {
    const f = await fixture(), signed = signedEvidence(f, { metadata: { account: 'acct_untrusted', merchantId: randomUUID() } }), send = await h.http(h.receiver(f.account));
    const { body } = await send(signed, { 'x-provider-account': 'acct_untrusted' }).expect(202);
    expect((await original(String(body.id)))[0]).toMatchObject([{ provider_account: f.account }]);
    expect(await obligations(String(body.id))).toMatchObject([{ merchant_id: null }]); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it('unconfigured server account makes original publication roll back the inserted inbox', async () => {
    const f = await fixture(), signed = signedEvidence(f), send = await h.http(h.receiver('acct_not_configured'));
    await send(signed).expect(500); expect(await inbox(signed.event.id)).toHaveLength(0); expect(await revisions(f)).toEqual({ scope: '0', intake: '0' });
  });
  it.each(['customer.created', 'invoice.created'])('unsupported %s retains the SQL-owned financial classification', async externalType => {
    const f = await fixture(), signed = signedEvidence(f, { externalType }), send = await h.http(h.receiver(f.account));
    const { body } = await send(signed).expect(202), id = String(body.id);
    expect((await original(id))[0][0].normalized_payload).toMatchObject({ type: 'provider.unsupported', data: null });
    expect(await obligations(id)).toHaveLength(externalType.startsWith('customer.') ? 0 : 1);
    if (externalType.startsWith('customer.')) expect(await h.read(f)).toHaveLength(1); else await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it.each(['pending', 'requires_action'])('genuine %s refund preserves nonblocking Option A', async status => {
    const f = await fixture(), signed = signedEvidence(f, { status }), result = await deliver(f, signed);
    expect(await obligations(result.id)).toMatchObject([{ operation: 'refund.pending', disposition: 'AWAITING_CONFIRMATION' }]);
    expect(await h.read(f)).toHaveLength(1); expect(await h.correlate(f.account).correlate(result.id)).toEqual({ state: 'NOT_SEALABLE' }); expect(await proofs(result.id)).toHaveLength(0);
  });
  it('first-publication permission failure rolls back all evidence and retry succeeds once', async () => {
    const f = await fixture(), signed = signedEvidence(f), send = await h.http(h.receiver(f.account));
    await h.db.sql.unsafe(`revoke execute on function public.publish_admitted_receipt(uuid,text,bytea,text) from "${h.roles.publisher}"`);
    try { await send(signed).expect(500); expect(await inbox(signed.event.id)).toHaveLength(0); expect(await revisions(f)).toEqual({ scope: '0', intake: '0' }); }
    finally { await h.db.sql.unsafe(`grant execute on function public.publish_admitted_receipt(uuid,text,bytea,text) to "${h.roles.publisher}"`); }
    const { body } = await send(signed).expect(202); expect(await obligations(String(body.id))).toHaveLength(1); expect(await inbox(signed.event.id)).toHaveLength(1);
  });
  it('exact repeated HTTP delivery preserves one original/obligation and one neutral replay witness', async () => {
    const f = await fixture(), signed = signedEvidence(f), send = await h.http(h.receiver(f.account));
    const first = (await send(signed).expect(202)).body, before = await original(String(first.id)), rev = await revisions(f);
    const second = (await send(signed).expect(202)).body, third = (await send(signed).expect(202)).body;
    expect(second).toEqual(third); expect(second).toMatchObject({ id: first.id, classification: 'EQUIVALENT', duplicate: true });
    expect(await attempts(String(first.id))).toHaveLength(1); expect(await barriers(String(first.id))).toHaveLength(0); expect(await obligations(String(first.id))).toHaveLength(1);
    expect(await original(String(first.id))).toEqual(before); expect(await revisions(f)).toEqual(rev);
  });
  it('refreshed valid signature/header is equivalent and does not advance evidence revision', async () => {
    const f = await fixture(), base = neutral(f), first = h.sign(base.raw, Math.floor(Date.now() / 1000) - 1), send = await h.http(h.receiver(f.account));
    const { body } = await send(first).expect(202), before = await original(String(body.id));
    const later = await send(h.sign(base.raw), { 'x-provider-retry': '1' }).expect(202);
    expect(later.body.classification).toBe('EQUIVALENT'); expect(await barriers(String(body.id))).toHaveLength(0); expect(await revisions(f)).toEqual({ scope: '0', intake: '0' }); expect(await original(String(body.id))).toEqual(before);
  });
  it('nonfinancial original then financial contradiction retains independent evidence and blocker', async () => {
    const f = await fixture(), base = neutral(f), send = await h.http(h.receiver(f.account)), first = (await send(base).expect(202)).body, id = String(first.id), before = await original(id);
    const signed = changed(base, f), conflict = (await send(signed).expect(202)).body;
    expect(conflict).toMatchObject({ id, classification: 'CONFLICT', duplicate: true }); expect(await original(id)).toEqual(before); expect(await obligations(id)).toHaveLength(0);
    expect(await attempts(id)).toMatchObject([{ raw_body: signed.raw, signature: signed.signature, classification: 'CONFLICT' }]);
    expect(await barriers(id)).toMatchObject([{ merchant_id: null, provider_account: f.account, disposition: 'BLOCKING_REVIEW' }]);
    expect(await revisions(f)).toEqual({ scope: '0', intake: '1' }); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it('distinct contradictions append evidence while exact conflict replay is stable', async () => {
    const f = await fixture(), base = neutral(f), result = await deliver(f, base), one = changed(base, f), two = changed(base, f, { status: 'failed' });
    const a = await deliver(f, one), b = await deliver(f, two), before = await revisions(f);
    expect(a.deliveryId).not.toBe(b.deliveryId); expect(await deliver(f, one)).toEqual(a);
    expect(await attempts(result.id)).toHaveLength(2); expect(await barriers(result.id)).toHaveLength(2); expect(await revisions(f)).toEqual(before); expect(before.intake).toBe('2');
  });
  it('invalid later signature cannot block an originally clear event', async () => {
    const f = await fixture(), base = neutral(f), send = await h.http(h.receiver(f.account)), first = (await send(base).expect(202)).body, signed = changed(base, f);
    await send({ ...signed, signature: 't=1,v1=invalid' }).expect(400);
    expect(await attempts(String(first.id))).toHaveLength(0); expect(await barriers(String(first.id))).toHaveLength(0); expect(await h.read(f)).toHaveLength(1);
  });
  it('HTTP conflict retention failure is not acknowledged and retry atomically retains its blocker', async () => {
    const f = await fixture(), base = neutral(f), first = await deliver(f, base), signed = changed(base, f), before = await original(first.id);
    const immediate: ReceiptTransactions = { transaction<T>(work: (tx: DbTransaction) => Promise<T>) {
      return h.publication.transaction(async tx => { await tx`set constraints all immediate`; return work(tx); });
    } };
    const failing = await h.http(h.receiver(f.account, immediate)); await failing(signed).expect(500);
    expect(await original(first.id)).toEqual(before); expect(await attempts(first.id)).toHaveLength(0); expect(await barriers(first.id)).toHaveLength(0);
    expect(await revisions(f)).toEqual({ scope: '0', intake: '0' }); expect(await h.read(f)).toHaveLength(1);
    const retry = await h.http(h.receiver(f.account)); await retry(signed).expect(202);
    expect(await attempts(first.id)).toHaveLength(1); expect(await barriers(first.id)).toHaveLength(1); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it('concurrent signed HTTP requests using separate restricted pools retain one original identity', async () => {
    const f = await fixture(), signed = signedEvidence(f), a = await h.http(h.receiver(f.account)), b = await h.http(h.receiver(f.account, h.peerPublication));
    const responses = await Promise.all([a(signed, { host: 'isolated-receipts.test' }).expect(202), b(signed, { host: 'isolated-receipts.test' }).expect(202)]);
    expect(responses[0].body.id).toBe(responses[1].body.id); expect(responses.map(r => r.body.duplicate).sort()).toEqual([false, true]);
    const id = String(responses[0].body.id); expect(await obligations(id)).toHaveLength(1); expect(await attempts(id)).toHaveLength(1);
    expect(await barriers(id)).toHaveLength(0); expect(await revisions(f)).toEqual({ scope: '0', intake: '1' });
  });
  it.each(['RETRY', 'DEAD'])('legacy inbox %s does not clear later financial blocking', async status => {
    const f = await fixture(), base = neutral(f), first = await deliver(f, base); await deliver(f, changed(base, f));
    await h.db.sql`update webhook_events set status=${status} where id=${first.id}`;
    expect(await barriers(first.id)).toHaveLength(1); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it('two independently configured endpoints retain account conflict without reassignment', async () => {
    const f = await fixture(), other = await fixture(), base = neutral(f), first = await deliver(f, base), snapshot = await original(first.id);
    const signed = changed(base, other, { providerAccount: other.account });
    expect((await deliver(other, signed)).classification).toBe('CONFLICT'); expect(await original(first.id)).toEqual(snapshot);
    expect(await barriers(first.id)).toMatchObject([{ provider_account: other.account, merchant_id: null }]); expect(await h.read(f)).toHaveLength(1); await expect(h.read(other)).rejects.toThrow(/blocked/);
  });
  it.each([false, true])('bare historical inbox with trusted snapshot=%s is not silently admitted', async receipt => {
    const f = await fixture(), signed = signedEvidence(f), id = await storeOriginalInbox(h.db, signed);
    if (receipt) {
      const { publishVerifiedReceipt } = await import('../support/trusted-evidence-fixtures'); await h.db.transaction(tx => publishVerifiedReceipt(tx, f, id, signed));
    }
    const send = await h.http(h.receiver(f.account)); const response = await send(signed).expect(409);
    expect(response.body.error?.code).toBe('HISTORICAL_RECEIPT_REVIEW_REQUIRED'); expect(await h.db.sql`select * from receipt_admissions where inbox_id=${id}`).toHaveLength(0);
    expect(await obligations(id)).toHaveLength(0); expect(await attempts(id)).toHaveLength(0);
  });
  it('ordinary application login cannot attest, insert trusted rows, clear barriers or reset revisions', async () => {
    const f = await fixture(), base = neutral(f), first = await deliver(f, base); await deliver(f, changed(base, f));
    await expect(h.worker`select public.publish_verified_receipt_delivery(${first.id},${f.account},${base.raw},${base.signature},'{}','{}','forged')`).rejects.toThrow(/permission denied/);
    await expect(h.worker`insert into receipt_delivery_attempts(id) values(${randomUUID()})`).rejects.toThrow(/permission denied/);
    await expect(h.worker`delete from receipt_delivery_barriers`).rejects.toThrow(/permission denied/);
    await expect(h.worker`update receipt_intake_authority set evidence_revision=0`).rejects.toThrow(/permission denied/); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it('owner application pool is refused even with a valid HTTP signature', async () => {
    const f = await fixture(), signed = signedEvidence(f), privileged = new RestrictedReceiptDatabase(h.db.sql, 'PUBLISHER');
    const send = await h.http(h.receiver(f.account, privileged)); const { body } = await send(signed).expect(500);
    expect(body.error?.code).toBe('RECEIPT_CAPABILITY_REQUIRED'); expect(await inbox(signed.event.id)).toHaveLength(0);
  });
  it('copies verified bytes before asynchronous publication so caller mutation cannot change evidence', async () => {
    const f = await fixture(), signed = signedEvidence(f), raw = Buffer.from(signed.raw), receiver = h.receiver(f.account);
    const pending = receiver.receive(raw, signed.signature); raw.fill(0);
    const result = await pending; expect((await original(result.id))[0]).toMatchObject([{ raw_body: signed.raw }]);
  });
  it('normalization-only disagreement with a retained original uses the checked R0.2 path', async () => {
    const f = await fixture(), signed = signedEvidence(f), payload = { ...signed.payload, type: 'refund.failed', data: { ...signed.payload.data!, providerStatus: 'failed' } };
    const [row] = await h.db.sql<{ id: string }[]>`insert into webhook_events(provider,provider_event_id,event_type,signature,payload,headers)
      values('STRIPE',${signed.event.id},'refund.failed',${signed.signature},${h.db.sql.json(payload)},'{}') returning id`;
    // Synthetic prior attestation exercises the accepted R0.1 contradictory
    // original contract; the later delivery is verified by the real adapter.
    await h.db.sql`select public.publish_admitted_receipt(${row.id},${f.account},${signed.raw},'previous-isolated-attester/v1')`;
    const snapshot = await original(row.id), result = await deliver(f, signed);
    expect(result.classification).toBe('CONFLICT'); expect(await original(row.id)).toEqual(snapshot);
    expect(await attempts(row.id)).toMatchObject([{ reason: 'NORMALIZATION_CONFLICT' }]); expect(await barriers(row.id)).toHaveLength(1); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });

  async function witnessed(f: EvidenceFixture, refund = false) {
    await h.db.transaction(async tx => { await publishCommandObservation(tx, f, 'CAPTURE'); if (refund) await publishCommandObservation(tx, f, 'REFUND'); });
  }
  async function bound(f: EvidenceFixture, signed: ReturnType<typeof signedEvidence>) {
    const result = await deliver(f, signed), before = await journals(f);
    const workflow = await h.db.sql`select to_jsonb(p) as payment,to_jsonb(r) as refund from payments p join refunds r on r.payment_id=p.id where p.id=${f.paymentId} order by r.id`;
    const correlated = await h.correlate(f.account).correlate(result.id);
    expect(correlated).toEqual({ state: 'BOUND', proofRevision: 1, merchantId: f.merchantId, paymentId: f.paymentId, currency: 'USD' });
    expect(await proofs(result.id)).toMatchObject([{ amount: '5000', merchant_id: f.merchantId, payment_id: f.paymentId, currency: 'USD' }]);
    expect(await obligations(result.id)).toMatchObject([{ proof_revision: 1, merchant_id: f.merchantId, disposition: 'AWAITING_APPLICATION' }]);
    expect(await journals(f)).toEqual(before);
    expect(await h.db.sql`select to_jsonb(p) as payment,to_jsonb(r) as refund from payments p join refunds r on r.payment_id=p.id where p.id=${f.paymentId} order by r.id`).toEqual(workflow);
    await expect(h.read(f)).rejects.toThrow(/blocked/); return result;
  }
  it('trusted refund correlation binds the exact accepted operation and original capture ownership', async () => {
    const f = await fixture(); await witnessed(f); const result = await bound(f, signedEvidence(f));
    const [proof] = await proofs(result.id); expect(proof.refund_id).toBe(f.refundId);
    expect(proof.capture_sources).toEqual([expect.objectContaining({ lot_id: f.lotId, attempt_id: f.attemptId, journal_id: String(f.journalId), gross: '10000', fee: '300', net: '9700' })]);
  });
  it('refund without optional metadata uses an independently retained owned command result', async () => {
    const f = await fixture(); await witnessed(f, true); const result = await bound(f, signedEvidence(f, { metadata: {} }));
    expect((await proofs(result.id))[0].refund_observation_id).not.toBeNull(); expect((await original(result.id))[0][0].normalized_payload).toMatchObject({ data: { providerTransactionId: f.objectId } });
  });
  it.each([true, false])('missing metadata without trusted refund witness, capture witness=%s, stays unknown', async capture => {
    const f = await fixture(); if (capture) await witnessed(f);
    const result = await deliver(f, signedEvidence(f, { metadata: {} })), before = await revisions(f);
    expect(await h.correlate(f.account).correlate(result.id)).toEqual({ state: 'UNRESOLVED', dependency: 'TRUSTED_CORRELATION' });
    expect(await proofs(result.id)).toHaveLength(0); expect(await obligations(result.id)).toMatchObject([{ merchant_id: null, disposition: 'AWAITING_CORRELATION' }]);
    const [review] = await h.db.sql`select reason,observations from financial_evidence_reviews where inbox_id=${result.id}`;
    expect(review.reason).toBe('UNRESOLVED'); expect(review.observations).toMatchObject({ dependency: 'TRUSTED_CORRELATION' });
    expect(await revisions(f)).toEqual(before); await expect(h.read(f)).rejects.toThrow(/blocked/);
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'UNRESOLVED' });
    expect(await h.db.sql`select id from financial_evidence_reviews where inbox_id=${result.id}`).toHaveLength(1);
  });
  it('signed owner metadata alone cannot substitute for missing immutable capture provenance', async () => {
    const f = await fixture(), result = await deliver(f, signedEvidence(f));
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'UNRESOLVED' }); expect(await proofs(result.id)).toHaveLength(0); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it.each([
    ['merchant', (f: EvidenceFixture) => ({ metadata: { merchantId: randomUUID(), paymentId: f.paymentId, refundId: f.refundId } })],
    ['payment', (f: EvidenceFixture) => ({ metadata: { merchantId: f.merchantId, paymentId: randomUUID(), refundId: f.refundId } })],
    ['currency', () => ({ object: { currency: 'eur' } })], ['amount', () => ({ object: { amount: 4999 } })],
    ['refund', () => ({ metadata: { refundId: randomUUID() } })],
  ])('contradictory %s cannot seal a guessed ownership proof', async (_label, changes) => {
    const f = await fixture(); await witnessed(f); const result = await deliver(f, signedEvidence(f, changes(f)));
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'UNRESOLVED' });
    expect(await proofs(result.id)).toHaveLength(0); expect(await obligations(result.id)).toMatchObject([{ merchant_id: null }]); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it('conflicting stored provider refund identity is refused without changing canonical evidence', async () => {
    const f = await fixture(); await witnessed(f); await h.db.sql`update refunds set provider_transaction_id=${f.objectId} where id=${f.refundId}`;
    const result = await deliver(f, signedEvidence(f, { object: { id: 're_other_verified_object' } }));
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'UNRESOLVED' }); expect(await proofs(result.id)).toHaveLength(0);
  });
  it.each([false, true])('dispute metadata omitted=%s uses owned capture provenance without an invented dispute command', async omitted => {
    const f = await fixture(); await witnessed(f); const before = await h.db.sql`select id from outbox_events where aggregate_id=${f.paymentId}`;
    const result = await bound(f, signedEvidence(f, { kind: 'dispute', ...(omitted ? { metadata: {} } : {}) }));
    expect((await proofs(result.id))[0]).toMatchObject({ provider_dispute_id: `dp_${f.refundId}`, refund_id: null });
    expect(await h.db.sql`select id from outbox_events where aggregate_id=${f.paymentId}`).toEqual(before);
  });
  it('a provider object cannot acquire a competing internal owner', async () => {
    const f = await fixture(); await witnessed(f); const one = await bound(f, signedEvidence(f)), saved = await proofs(one.id);
    const other = await fixture(f.account); await witnessed(other);
    const two = await deliver(other, signedEvidence(other, { object: { id: f.objectId } }));
    expect(await h.correlate(other.account).correlate(two.id)).toMatchObject({ state: 'UNRESOLVED' });
    expect(await proofs(two.id)).toHaveLength(0); expect(await proofs(one.id)).toEqual(saved);
    expect(await h.db.sql`select * from provider_financial_object_owners where provider_account=${f.account} and provider_object_id=${f.objectId}`).toHaveLength(1);
  });
  it('duplicate proof sealing/binding preserves one immutable proof and stable revisions', async () => {
    const f = await fixture(); await witnessed(f); const result = await bound(f, signedEvidence(f)), snapshot = await original(result.id), before = await revisions(f);
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'BOUND' });
    expect(await original(result.id)).toEqual(snapshot); expect(await revisions(f)).toEqual(before); expect(await proofs(result.id)).toHaveLength(1);
  });
  it('binding failure after proof commit remains blocked and retry completes the guarded transfer', async () => {
    const f = await fixture(); await witnessed(f); const result = await deliver(f, signedEvidence(f));
    await h.db.sql.unsafe(`revoke execute on function public.bind_receipt_obligation(uuid,integer) from "${h.roles.correlator}"`);
    try { await expect(h.correlate(f.account).correlate(result.id)).rejects.toThrow(/permission denied/); }
    finally { await h.db.sql.unsafe(`grant execute on function public.bind_receipt_obligation(uuid,integer) to "${h.roles.correlator}"`); }
    expect(await proofs(result.id)).toHaveLength(1); expect(await obligations(result.id)).toMatchObject([{ merchant_id: null }]); await expect(h.read(f)).rejects.toThrow(/blocked/);
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'BOUND' }); expect(await proofs(result.id)).toHaveLength(1);
  });
  it('unknown-to-known binding advances both authorities and releases only the broad account blocker', async () => {
    const f = await fixture(), other = await fixture(f.account), [clear] = await h.read(f); await witnessed(f);
    const result = await deliver(f, signedEvidence(f)); await expect(h.read(other)).rejects.toThrow(/blocked/);
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'BOUND' });
    expect(await revisions(f)).toEqual({ scope: '1', intake: '2' }); expect(await h.read(other)).toHaveLength(1); await expect(h.read(f)).rejects.toThrow(/blocked/);
    await expect(h.read(f, String(clear.scope_revision), String(clear.intake_revision))).rejects.toThrow(/Stale/);
  });
  it('correlation never clears an independent later-delivery barrier', async () => {
    const f = await fixture(); await witnessed(f); const signed = signedEvidence(f), result = await deliver(f, signed);
    await deliver(f, changed(signed, f, { status: 'failed' })); const saved = await barriers(result.id);
    expect(await h.correlate(f.account).correlate(result.id)).toMatchObject({ state: 'BOUND' }); expect(await barriers(result.id)).toEqual(saved);
    await expect(h.read(f)).rejects.toThrow(/blocked/); expect(saved).toMatchObject([{ merchant_id: null }]);
  });
  it('a nonfinancial original cannot be resealed to consume its later financial contradiction', async () => {
    const f = await fixture(), base = neutral(f), result = await deliver(f, base); await deliver(f, changed(base, f));
    expect(await h.correlate(f.account).correlate(result.id)).toEqual({ state: 'NOT_SEALABLE' }); expect(await obligations(result.id)).toHaveLength(0);
    expect(await barriers(result.id)).toHaveLength(1); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it('correlation rejects a receipt from another configured account', async () => {
    const f = await fixture(), other = await fixture(), result = await deliver(f, signedEvidence(f));
    await expect(h.correlate(other.account).correlate(result.id)).rejects.toMatchObject({ code: 'RECEIPT_CONTEXT_REQUIRED' }); expect(await proofs(result.id)).toHaveLength(0);
  });

  function transactions(sql: Sql): ReceiptTransactions {
    return { transaction<T>(work: (tx: DbTransaction) => Promise<T>) { return sql.begin('isolation level read committed', work) as Promise<T>; } };
  }
  async function contention(base: ReceiptTransactions, first: (runner: ReceiptTransactions) => Promise<unknown>, secondSql: Sql, second: () => Promise<unknown>, blockedReader = false) {
    let release!: () => void, ready!: () => void, holder = 0, entered = false;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { ready = r; });
    const runner: ReceiptTransactions = { transaction<T>(work: (tx: DbTransaction) => Promise<T>) {
      return base.transaction(async tx => {
        const pause = !entered; entered = true;
        if (pause) holder = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid;
        const result = await work(tx); if (pause) { ready(); await gate; } return result;
      });
    } };
    const held = first(runner); let pending: Promise<{ result?: unknown; error?: unknown }> | undefined;
    try {
      await Promise.race([started, held]);
      const waiter = (await secondSql<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid; expect(waiter).not.toBe(holder);
      pending = second().then(result => ({ result }), (error: unknown) => ({ error }));
      let observed = false;
      for (let i = 0; i < 200; i++) {
        if ((await h.db.sql<{ yes: boolean }[]>`select ${holder}=any(pg_blocking_pids(${waiter})) as yes`)[0].yes) { observed = true; break; }
        await delay(20);
      }
      expect(observed).toBe(true); release(); await held; const outcome = await pending;
      if (blockedReader) { expect(outcome.error).toMatchObject({ code: 'P0001' }); expect(String((outcome.error as Error).message)).toMatch(/blocked/); }
      else expect(outcome.error).toBeUndefined();
    } finally { release(); await Promise.allSettled([held, ...(pending ? [pending] : [])]); }
  }
  it('two identical first deliveries wait on database identity and retain one original obligation', async () => {
    const f = await fixture(), signed = signedEvidence(f);
    await contention(h.publication, runner => deliver(f, signed, runner), h.peer, () => deliver(f, signed, h.peerPublication));
    const [row] = await inbox(signed.event.id), id = String(row.id);
    expect(await inbox(signed.event.id)).toHaveLength(1); expect(await obligations(id)).toHaveLength(1); expect(await attempts(id)).toMatchObject([{ classification: 'EQUIVALENT' }]);
    expect(await barriers(id)).toHaveLength(0); expect(await revisions(f)).toEqual({ scope: '0', intake: '1' });
  });
  it.each([false, true])('racing first/conflicting delivery reversed=%s re-evaluates the committed winner', async reversed => {
    const f = await fixture(), base = neutral(f), financial = changed(base, f), first = reversed ? financial : base, second = reversed ? base : financial;
    await contention(h.publication, runner => deliver(f, first, runner), h.peer, () => deliver(f, second, h.peerPublication));
    const [row] = await inbox(base.event.id), id = String(row.id);
    expect((await original(id))[0]).toMatchObject([{ raw_body: first.raw }]); expect(await obligations(id)).toHaveLength(reversed ? 1 : 0);
    expect(await attempts(id)).toMatchObject([{ classification: 'CONFLICT', raw_body: second.raw }]); expect(await barriers(id)).toHaveLength(1);
    expect((await revisions(f)).intake).toBe(reversed ? '2' : '1'); await expect(h.read(f)).rejects.toThrow(/blocked/);
  });
  it('concurrent exact conflicting replay creates only one retained witness and barrier', async () => {
    const f = await fixture(), base = neutral(f), first = await deliver(f, base), signed = changed(base, f);
    await contention(h.publication, runner => deliver(f, signed, runner), h.peer, () => deliver(f, signed, h.peerPublication));
    expect(await attempts(first.id)).toHaveLength(1); expect(await barriers(first.id)).toHaveLength(1); expect((await revisions(f)).intake).toBe('1');
  });
  it.each([false, true])('adapter conflict versus admission reader reversed=%s follows the same authority', async reversed => {
    const f = await fixture(), base = neutral(f), first = await deliver(f, base), signed = changed(base, f), [before] = await h.read(f);
    if (reversed) await contention(transactions(h.worker), runner => runner.transaction(tx => h.inspect(tx, f)), h.peer, () => deliver(f, signed, h.peerPublication));
    else await contention(h.publication, runner => deliver(f, signed, runner), h.worker, () => h.read(f), true);
    expect(await barriers(first.id)).toHaveLength(1); await expect(h.read(f)).rejects.toThrow(/blocked/);
    await expect(h.read(f, String(before.scope_revision), String(before.intake_revision))).rejects.toThrow(/Stale/);
  });
  it.each([false, true])('unknown conflict versus another scoped binding reversed=%s preserves account protection', async reversed => {
    const f = await fixture(), other = await fixture(f.account); await witnessed(other);
    const base = neutral(f), first = await deliver(f, base), another = await deliver(other, signedEvidence(other)), signed = changed(base, f);
    await h.correlation.transaction(tx => tx`select public.seal_financial_correlation(${another.id},0)`);
    const binding = (runner: ReceiptTransactions) => runner.transaction(tx => tx`select public.bind_receipt_obligation(${another.id},1)`);
    if (reversed) await contention(h.correlation, binding, h.peer, () => deliver(f, signed, h.peerPublication));
    else await contention(h.publication, runner => deliver(f, signed, runner), h.correlator, () => binding(h.correlation));
    expect(await obligations(another.id)).toMatchObject([{ merchant_id: other.merchantId }]); expect(await barriers(first.id)).toMatchObject([{ merchant_id: null }]);
    expect(await revisions(other)).toEqual({ scope: '1', intake: '3' }); await expect(h.read(other)).rejects.toThrow(/blocked/);
  });
  it.each([false, true])('sealer versus guarded binding reversed=%s has no reverse lock dependency', async reversed => {
    const f = await fixture(); await witnessed(f); const result = await deliver(f, signedEvidence(f));
    if (reversed) await h.correlation.transaction(tx => tx`select public.seal_financial_correlation(${result.id},0)`);
    const binding = (runner: ReceiptTransactions) => runner.transaction(tx => tx`select public.bind_receipt_obligation(${result.id},1)`);
    if (reversed) await contention(h.correlation, binding, h.correlationPeer, () => h.correlate(f.account, h.peerCorrelation).correlate(result.id));
    else await contention(h.correlation, runner => h.correlate(f.account, runner).correlate(result.id), h.correlationPeer, () => binding(h.peerCorrelation));
    expect(await proofs(result.id)).toHaveLength(1); expect(await obligations(result.id)).toMatchObject([{ merchant_id: f.merchantId, proof_revision: 1 }]);
    expect(await revisions(f)).toEqual({ scope: '1', intake: '2' });
  });
  function aborting(sql: Sql, code: '40001' | '40P01' | '23505', always = false) {
    let calls = 0;
    const proxy = new Proxy(sql, { get(target, key, receiver) {
      if (key !== 'begin') return Reflect.get(target, key, receiver) as unknown;
      return (options: string, work: (tx: DbTransaction) => Promise<unknown>) => target.begin(options, async tx => {
        const result = await work(tx); calls++;
        if (always || calls === 1) await tx.unsafe(`do $$ begin raise exception 'isolated R1 rollback fixture' using errcode='${code}'; end $$`);
        return result;
      });
    } });
    return { database: new RestrictedReceiptDatabase(proxy, 'PUBLISHER'), calls: () => calls };
  }
  it.each(['40001', '40P01'] as const)('injected PostgreSQL %s abort retries the entire transaction without duplicate evidence', async code => {
    const f = await fixture(), signed = signedEvidence(f), injected = aborting(h.publisher, code), result = await deliver(f, signed, injected.database);
    expect(injected.calls()).toBe(2); expect(await inbox(signed.event.id)).toHaveLength(1); expect(await obligations(result.id)).toHaveLength(1);
    expect(await revisions(f)).toEqual({ scope: '0', intake: '1' }); expect(await attempts(result.id)).toHaveLength(0);
  });
  it('bounded retry exhaustion propagates failure with no retained partial first delivery', async () => {
    const f = await fixture(), signed = signedEvidence(f), injected = aborting(h.publisher, '40001', true);
    await expect(deliver(f, signed, injected.database)).rejects.toMatchObject({ code: '40001' });
    expect(injected.calls()).toBe(3); expect(await inbox(signed.event.id)).toHaveLength(0); expect(await revisions(f)).toEqual({ scope: '0', intake: '0' });
  });
  it('unexpected uniqueness errors propagate rather than being acknowledged as a duplicate', async () => {
    const f = await fixture(), signed = signedEvidence(f), injected = aborting(h.publisher, '23505');
    await expect(deliver(f, signed, injected.database)).rejects.toMatchObject({ code: '23505' }); expect(injected.calls()).toBe(1); expect(await inbox(signed.event.id)).toHaveLength(0);
  });
});
