import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { firstCaptureIntentHarness, type IntentVariant } from './first-capture-intent-harness';

export interface CapturePreparationRequest {
  intent: string; inbox: string; proof: string; generation: number; obligation: string; scope: string; intake: string;
}
export interface CapturePreparationPlan {
  id: string; root_id: string; proof_kind: string; result: string; payment_operation_proof_id: string;
  source_manifest: { contract: string; executable: boolean; money: Record<string, number>;
    terms: Record<string, number>; inventory: { receipts: unknown[]; sources: unknown[]; authorization_causes: unknown[] } };
  effect_manifest: { kind: string; [key: string]: unknown }[];
}
export async function capturePreparationHarness(folder?: string) {
  const h = await firstCaptureIntentHarness(folder);
  await h.db.sql.unsafe(`grant execute on function public.claim_capture_preparation(uuid),
    public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint),public.read_capture_preparation() to "${h.worker.role}"`);
  async function install() {
    await h.install();
    await h.db.sql`insert into financial_application_contracts(family,phase,policy,version,prepare_function,validate_function)
      values('CAPTURE','TERMINAL','LEGACY',1,'public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure,
        'public.validate_capture_preparation(uuid)'::regprocedure)`;
  }
  async function fixture(options: { variant?: IntentVariant; gross?: number; authorized?: number; currency?: string; bps?: number; fixed?: string; days?: number; claim?: boolean } = {}) {
    const f = await h.fixture({ amount: options.authorized ?? 10000, currency: options.currency });
    const request = await h.request(f, options.variant ?? 'FULL', options.gross ?? f.amount);
    const [accepted] = await h.accept(request), capture = await h.captureEvidence(f, accepted.result);
    const [intent] = await h.db.sql<{ id: string }[]>`select id from first_capture_intent_manifests where attempt_id=${accepted.result.body.attemptId}`;
    await h.db.sql`update merchants set fee_bps=${options.bps ?? 300},fixed_fee_minor=${options.fixed ?? '0'},settlement_delay_days=${options.days ?? 2} where id=${f.merchantId}`;
    const generation = options.claim === false ? 0 : Number((await h.worker.sql`select public.claim_capture_preparation(${capture.inboxId}) n`)[0].n);
    return { ...f, accepted: accepted.result, capture, intentId: intent.id, generation };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function revisions(f: Fixture): Promise<CapturePreparationRequest> {
    const [rev] = await h.db.sql`select
      (select obligation_revision::text from receipt_admission_obligations where inbox_id=${f.capture.inboxId}) obligation,
      (select evidence_revision::text from capture_accounting_scopes where merchant_id=${f.merchantId} and currency=${f.currency}) scope,
      (select evidence_revision::text from receipt_intake_authority where provider='STRIPE' and provider_account=${f.account}) intake`;
    return { intent: f.intentId, inbox: f.capture.inboxId, proof: f.capture.proofId, generation: f.generation,
      obligation: String(rev.obligation), scope: String(rev.scope), intake: String(rev.intake) };
  }
  const prepare = (tx: TransactionSql, r: CapturePreparationRequest) => tx<{ id: string }[]>`select public.prepare_capture_application(
    ${r.intent},${r.inbox},${r.proof},${r.generation},${r.obligation},${r.scope},${r.intake}) id`;
  const read = (tx: TransactionSql) => tx<{ plan: CapturePreparationPlan }[]>`select to_jsonb(public.read_capture_preparation()) plan`;
  async function inspectPlan(f: Fixture, r?: CapturePreparationRequest, connection: Sql = h.worker.sql) {
    const request = r ?? await revisions(f), rollback = new Error('intentional preparation rollback'); let result: CapturePreparationPlan | undefined;
    try { await connection.begin(async tx => { await prepare(tx, request); result = (await read(tx))[0].plan; throw rollback; }); }
    catch (error) { if (error !== rollback) throw error; }
    if (!result) throw new Error('No capture plan inspected'); return result;
  }
  async function state(f: Fixture) {
    const [row] = await h.db.sql`select
      (select to_jsonb(p) from payments p where id=${f.paymentId}) payment,
      (select jsonb_agg(to_jsonb(a) order by id) from payment_attempts a where payment_id=${f.paymentId}) attempts,
      (select jsonb_agg(to_jsonb(a) order by id) from audit_logs a where target_id=${f.paymentId}) audits,
      (select jsonb_agg(to_jsonb(o) order by inbox_id) from receipt_admission_obligations o where payment_id=${f.paymentId}) receipts,
      (select jsonb_agg(to_jsonb(o) order by source_id) from provider_observation_obligations o where merchant_id=${f.merchantId}) sources,
      (select to_jsonb(w) from webhook_events w where id=${f.capture.inboxId}) inbox,
      (select to_jsonb(s) from capture_accounting_scopes s where merchant_id=${f.merchantId} and currency=${f.currency}) scope,
      (select evidence_revision from receipt_intake_authority where provider='STRIPE' and provider_account=${f.account}) intake,
      (select count(*)::int from financial_application_roots where payment_id=${f.paymentId}) roots,
      (select count(*)::int from financial_application_manifests where payment_id=${f.paymentId}) manifests,
      (select count(*)::int from financial_applications a join financial_application_roots r on r.id=a.root_id where r.payment_id=${f.paymentId}) applications,
      (select count(*)::int from capture_preparation_issuances) preparations,
      (select count(*)::int from financial_application_effect_links where payment_id=${f.paymentId}) links,
      (select count(*)::int from capture_accounting_lots where payment_id=${f.paymentId}) lots,
      (select count(*)::int from ledger_transactions where merchant_id=${f.merchantId}) journals`;
    return row;
  }
  return { ...h, install, fixture, captureRevisions: revisions, prepareCapture: prepare, readCapture: read, inspectPlan, captureState: state, randomUUID };
}
