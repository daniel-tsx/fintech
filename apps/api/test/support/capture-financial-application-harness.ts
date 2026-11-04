import type { Sql, TransactionSql } from 'postgres';
import { OutboxService } from '../../src/outbox/outbox.service';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import type { ProviderCommandEnvelope } from '../../src/rabbitmq/rabbitmq.types';
import type { PaymentEvent, PaymentObject } from './payment-operation-harness';
import { ScriptedStripeHttp } from './provider-observation-harness';
import { capturePreparationHarness, type CapturePreparationRequest } from './capture-preparation-harness';

export type CaptureRow = Record<string, unknown>;
export interface CaptureApplicationState {
  payment: CaptureRow & { version: number }; scope: CaptureRow & { evidence_revision: number | string };
  inbox: CaptureRow; attempts: CaptureRow[]; audits: CaptureRow[]; receipts: CaptureRow[]; sources: CaptureRow[]; intake: string;
  roots: number; manifests: number; applications: number; preparations: number; links: number; lots: number; journals: number;
  journal_rows: CaptureRow[]; entry_rows: CaptureRow[]; lot_rows: CaptureRow[]; application_rows: CaptureRow[];
  disposition_rows: CaptureRow[]; revision_rows: CaptureRow[]; link_rows: CaptureRow[]; owned_accounts: CaptureRow[];
}
export interface CaptureEffect {
  table: string; id: string; write: 'INSERT' | 'UPDATE'; before: CaptureRow | null; after: CaptureRow;
}
export interface CaptureApplicationPlan {
  id: string; root_id: string; payment_id: string; inbox_id: string; claim_generation: number;
  scope_revision: string; intake_revision: string; proof_kind: string; result: string; payment_operation_proof_id: string;
  source_manifest: {
    contract: string; executable: boolean; applied_at: string; audit_id: string;
    money: Record<string, number>; terms: Record<string, number>;
    payment_before: CaptureRow; attempt_before: CaptureRow; inbox_before: CaptureRow;
    inventory: { receipts: CaptureRow[]; sources: CaptureRow[]; authorization_causes: CaptureRow[] };
    accounts: { row: CaptureRow; created: boolean }[];
    completion: { table: string; id: string; after: CaptureRow }[];
    ids: { journal: string; lot: string; audit: string; entries: Record<string, string> };
    [key: string]: unknown;
  };
  effect_manifest: CaptureEffect[];
}

export async function captureFinancialApplicationHarness(folder?: string) {
  const h = await capturePreparationHarness(folder);
  // Test-only composition: migrations grant no executable capture API to a LOGIN.
  await h.db.sql.unsafe(`grant execute on function public.apply_capture_application() to "${h.worker.role}"`);
  type Fixture = Awaited<ReturnType<typeof h.fixture>>;
  type AuthorizationFixture = Awaited<ReturnType<typeof h.authorizationFixture>>;
  async function captureFromAuthorization(initial: AuthorizationFixture): Promise<Fixture> {
    const [authorization] = await h.complete(initial), authorized = { ...initial, rootId: authorization.id };
    const [accepted] = await h.accept(await h.request(authorized)), capture = await h.captureEvidence(authorized, accepted.result);
    const [intent] = await h.db.sql<{ id: string }[]>`select id from first_capture_intent_manifests where attempt_id=${accepted.result.body.attemptId}`;
    const generation = Number((await h.worker.sql`select public.claim_capture_preparation(${capture.inboxId}) n`)[0].n);
    return { ...authorized, accepted: accepted.result, capture, intentId: intent.id, generation };
  }
  async function acceptedSibling(previous: AuthorizationFixture): Promise<() => Promise<Fixture>> {
    const paymentId = h.randomUUID(), attemptId = h.randomUUID(), pi = `pi_${h.randomUUID().replaceAll('-', '')}`, charge = `ch_${h.randomUUID().replaceAll('-', '')}`;
    const { merchantId, account, currency, amount } = previous, requestId = `req_${attemptId}`;
    const payload = { merchantId, paymentId, attemptId, amount, currency, paymentMethodToken: 'pm_fixture', idempotencyKey: `authorize:${attemptId}` };
    const outboxId = await h.initial.sql.begin(async tx => {
      await tx`insert into payments(id,merchant_id,status,capture_method,currency,amount,payment_method_token)
        values(${paymentId},${merchantId},'REQUIRES_AUTHORIZATION','MANUAL',${currency},${amount},'pm_fixture')`;
      await tx`insert into payment_attempts(id,merchant_id,payment_id,kind,amount,currency) values(${attemptId},${merchantId},${paymentId},'AUTHORIZE',${amount},${currency})`;
      const id = await new OutboxService().add(tx, { aggregateType: 'PAYMENT_ATTEMPT', aggregateId: attemptId, eventType: 'provider.authorization.requested', payload });
      await tx`insert into audit_logs(id,merchant_id,actor_type,action,target_type,target_id,metadata)
        values(${h.randomUUID()},${merchantId},'SYSTEM','payment.authorization_requested','payment',${paymentId},'{}')`;
      await tx`select public.accept_provider_command(${id},${account},'TEST')`; return id;
    });
    const message: ProviderCommandEnvelope = { id: outboxId, aggregateId: attemptId, eventType: 'provider.authorization.requested', payload,
      createdAt: new Date().toISOString(), correlationId: h.randomUUID() };
    const object: PaymentObject = { id: pi, object: 'payment_intent', amount, amount_received: 0, amount_capturable: amount,
      currency: currency.toLowerCase(), latest_charge: charge, livemode: false, status: 'requires_capture', capture_method: 'manual', metadata: { merchantId, paymentId, authorizeAttemptId: attemptId } };
    const exchange: Fixture['exchange'] = (value = object, database = h.publication) => {
      const transport = new ScriptedStripeHttp(() => ({ body: Buffer.from(JSON.stringify(value)), headers: { 'request-id': requestId } }));
      return new TrustedProviderObservations(database, { account, mode: 'TEST', apiKey: 'sk_test_b2b_scope_fixture', maxNetworkRetries: 0 }, transport).execute(message);
    };
    const event: PaymentEvent = { ...previous.event, id: `evt_${h.randomUUID()}`, created: Math.floor(Date.now() / 1000),
      request: { id: requestId, idempotency_key: payload.idempotencyKey }, data: { object } };
    const receive: Fixture['receive'] = (value = event) => previous.receive(value);
    return async () => {
      const observed = await exchange(), [source] = await observed.publish(), receipt = await receive();
      const sealed = await h.evidence.seal(receipt.id, 0, '0', source.id, null); expect(sealed.state).toBe('SEALED');
      await h.evidence.bind(receipt.id, sealed.proof_id!, '0');
      return captureFromAuthorization({ ...previous, paymentId, attemptId, outboxId, pi, charge, payload, message, object, event, sourceId: source.id,
        inboxId: receipt.id, proofId: sealed.proof_id!, observed, exchange, receive });
    };
  }
  async function fixturePair() {
    const firstInitial = await h.authorizationFixture({ enroll: false });
    // Accept both initial requests before the private scope floor; publish the sibling result later.
    const next = await acceptedSibling(firstInitial);
    await firstInitial.enroll();
    return { first: await captureFromAuthorization(firstInitial), next };
  }
  const readCapture = (tx: TransactionSql) => tx<{ plan: CaptureApplicationPlan }[]>`select to_jsonb(public.read_capture_preparation()) plan`;
  const applyCapture = (tx: TransactionSql) => tx<{ id: string }[]>`select public.apply_capture_application() id`;
  const completeCaptureIn = async (tx: TransactionSql, request: CapturePreparationRequest) => {
    await h.prepareCapture(tx, request); return applyCapture(tx);
  };
  async function completeCapture(f: Fixture, sql: Sql = h.worker.sql, request?: CapturePreparationRequest) {
    const current = request ?? await h.captureRevisions(f);
    return sql.begin(tx => completeCaptureIn(tx, current));
  }
  async function inspectPlan(f: Fixture, request?: CapturePreparationRequest, sql: Sql = h.worker.sql) {
    const current = request ?? await h.captureRevisions(f), rollback = new Error('intentional capture inspection rollback');
    let result: CaptureApplicationPlan | undefined;
    try {
      await sql.begin(async tx => { await h.prepareCapture(tx, current); result = (await readCapture(tx))[0].plan; throw rollback; });
    } catch (error) { if (error !== rollback) throw error; }
    if (!result) throw new Error('No executable capture plan inspected'); return result;
  }
  async function captureState(f: Fixture): Promise<CaptureApplicationState> {
    const before = await h.captureState(f);
    const [effects] = await h.db.sql`select
      (select count(*)::int from capture_preparation_issuances i join financial_application_roots r on r.id=i.root_id where r.payment_id=${f.paymentId}) preparations,
      (select coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]') from ledger_transactions j where j.merchant_id=${f.merchantId}) journal_rows,
      (select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]') from ledger_entries e join ledger_transactions j on j.id=e.transaction_id where j.merchant_id=${f.merchantId}) entry_rows,
      (select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]') from capture_accounting_lots l where l.payment_id=${f.paymentId}) lot_rows,
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.root_id),'[]') from financial_applications a join financial_application_roots r on r.id=a.root_id where r.payment_id=${f.paymentId} and r.family='CAPTURE') application_rows,
      (select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]') from financial_application_dispositions d join financial_application_roots r on r.id=d.root_id where r.payment_id=${f.paymentId} and r.family='CAPTURE') disposition_rows,
      (select coalesce(jsonb_agg(to_jsonb(v) order by v.root_id),'[]') from financial_application_revision_effects v join financial_application_roots r on r.id=v.root_id where r.payment_id=${f.paymentId} and r.family='CAPTURE') revision_rows,
      (select coalesce(jsonb_agg(to_jsonb(l) order by l.effect_id),'[]') from financial_application_effect_links l where l.payment_id=${f.paymentId}) link_rows,
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from ledger_accounts a where a.merchant_id=${f.merchantId}) owned_accounts`;
    return { ...before, ...effects } as CaptureApplicationState;
  }
  return { ...h, fixturePair, readCapture, applyCapture, completeCaptureIn, completeCapture, inspectPlan, captureState,
    close: (expectedMigrations = 17) => h.close(expectedMigrations) };
}
