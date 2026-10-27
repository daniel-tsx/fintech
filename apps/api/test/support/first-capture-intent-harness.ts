import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import type { ProviderCommandEnvelope } from '../../src/rabbitmq/rabbitmq.types';
import { manualAuthorizationHarness } from './manual-authorization-harness';
import type { PaymentEvent, PaymentObject } from './payment-operation-harness';
import { ScriptedStripeHttp } from './provider-observation-harness';

export type IntentVariant = 'FULL' | 'FIRST_PARTIAL' | 'FINAL_PARTIAL';
export interface IntentRequest {
  rootId: string; key: string; amount: number | string; variant: string;
  version: number; scope: string; intake: string;
}
export interface IntentResponse {
  statusCode: number;
  body: { paymentId: string; attemptId: string; status: string; amount: number };
}

export async function firstCaptureIntentHarness(migrationsFolder?: string) {
  const h = await manualAuthorizationHarness(migrationsFolder);
  await h.db.sql.unsafe(`grant execute on function public.prepare_first_capture_intent(uuid,text,numeric,text,integer,bigint,bigint),
    public.apply_first_capture_intent(),public.accept_first_capture_intent(uuid,text,numeric,text,integer,bigint,bigint) to "${h.worker.role}"`);
  async function install() {
    await h.install();
    await h.db.sql`insert into financial_application_contracts(family,phase,policy,version,prepare_function,validate_function)
      values('CAPTURE','INTENT_ACCEPTANCE','LEGACY',1,'public.prepare_first_capture_intent(uuid,text,numeric,text,integer,bigint,bigint)'::regprocedure,
        'public.validate_first_capture_intent(uuid)'::regprocedure)`;
  }
  async function fixture(options: Parameters<typeof h.fixture>[0] = {}) {
    const f = await h.fixture(options), [completed] = await h.complete(f);
    return { ...f, rootId: completed.id };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function request(f: Fixture, variant: IntentVariant = 'FULL', amount = f.amount): Promise<IntentRequest> {
    const rev = await h.revisions(f), [payment] = await h.db.sql<{ version: number }[]>`select version from payments where id=${f.paymentId}`;
    return { rootId: f.rootId, key: `pc_${randomUUID()}`, amount, variant, version: payment.version, scope: rev.scope, intake: rev.intake };
  }
  const prepare = (tx: TransactionSql, r: IntentRequest) => tx<{ id: string }[]>`select public.prepare_first_capture_intent(
    ${r.rootId},${r.key},${r.amount}::numeric,${r.variant},${r.version},${r.scope},${r.intake}) id`;
  const apply = (tx: TransactionSql) => tx<{ result: IntentResponse }[]>`select public.apply_first_capture_intent() result`;
  const acceptIn = (tx: TransactionSql, r: IntentRequest) => tx<{ result: IntentResponse }[]>`select public.accept_first_capture_intent(
    ${r.rootId},${r.key},${r.amount}::numeric,${r.variant},${r.version},${r.scope},${r.intake}) result`;
  const accept = (r: IntentRequest, sql = h.worker.sql) => sql.begin(tx => acceptIn(tx, r));

  async function captureEvidence(f: Fixture, response: IntentResponse) {
    // Only committed SQL-produced commands enter the scripted SDK transport.
    const [outbox] = await h.db.sql<{ id: string; aggregate_id: string; payload: ProviderCommandEnvelope['payload']; created_at: Date }[]>`
      select id,aggregate_id,payload,created_at from outbox_events where aggregate_id=${response.body.attemptId} and event_type='provider.capture.requested'`;
    if (!outbox) throw new Error('Committed first-capture command required');
    const payload = outbox.payload as { amount: number; finalCapture: boolean; idempotencyKey: string };
    const amount = Number(payload.amount), final = payload.finalCapture, requestId = `req_${outbox.aggregate_id}`;
    const object: PaymentObject = { ...structuredClone(f.object), amount_received: amount, amount_capturable: final ? 0 : f.amount - amount,
      status: final ? 'succeeded' : 'requires_capture', metadata: { ...f.object.metadata,
        captureAttemptId: outbox.aggregate_id, captureAmount: String(amount), currency: f.currency } };
    const transport = new ScriptedStripeHttp(() => ({ body: Buffer.from(JSON.stringify(object)), headers: { 'request-id': requestId } }));
    const producer = new TrustedProviderObservations(h.publication, { account: f.account, mode: 'TEST', apiKey: 'sk_test_pc_fixture', maxNetworkRetries: 0 }, transport);
    const message: ProviderCommandEnvelope = { id: outbox.id, aggregateId: outbox.aggregate_id, eventType: 'provider.capture.requested', payload: outbox.payload,
      createdAt: outbox.created_at.toISOString(), correlationId: randomUUID() };
    const pending = await producer.execute(message), [source] = await pending.publish();
    const event: PaymentEvent = { id: `evt_${randomUUID()}`, object: 'event', account: f.account, api_version: '2026-08-26.dahlia', livemode: false,
      created: Math.floor(Date.now() / 1000), type: final ? 'payment_intent.succeeded' : 'payment_intent.amount_capturable_updated',
      request: { id: requestId, idempotency_key: payload.idempotencyKey }, data: { object,
        ...(!final ? { previous_attributes: { amount_capturable: f.amount } } : {}) } };
    const receipt = await f.receive(event), sealed = await h.evidence.seal(receipt.id, 0, '0', source.id, f.sourceId);
    expect(sealed.state).toBe('SEALED');
    await h.evidence.bind(receipt.id, sealed.proof_id!, '0');
    return { outbox, message, object, event, transport, pending, sourceId: source.id, inboxId: receipt.id, proofId: sealed.proof_id! };
  }
  return { ...h, install, authorizationFixture: h.fixture, fixture, request, prepareIntent: prepare, applyIntent: apply, acceptIn, accept, captureEvidence };
}
