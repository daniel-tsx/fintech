import { randomBytes, randomUUID } from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { OutboxService } from '../../src/outbox/outbox.service';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import type { ObservationTransactions } from '../../src/payment-provider/provider-observation-database';
import type { ProviderCommandEnvelope } from '../../src/rabbitmq/rabbitmq.types';
import { RestrictedReceiptDatabase } from '../../src/webhooks/trusted-receipt-database';
import { TrustedPaymentOperationEvidence } from '../../src/webhooks/trusted-payment-operation-evidence';
import { TrustedSignedReceiptService } from '../../src/webhooks/trusted-signed-receipt.service';
import type { PaymentEvent, PaymentObject } from './payment-operation-harness';
import { providerObservationHarness, ScriptedStripeHttp } from './provider-observation-harness';

export async function manualAuthorizationHarness(migrationsFolder?: string) {
  const h = await providerObservationHarness(migrationsFolder), r = h.receipt, clients: Sql[] = [];
  const database = String((await h.db.sql`select current_database() n`)[0].n);
  async function login(label: string) {
    const role = `pb_${label}_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
    await h.db.sql.unsafe(`create role "${role}" login password '${password}' noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await h.db.sql.unsafe(`grant usage on schema public to "${role}"`);
    const url = new URL(process.env.MIGRATION_ADMIN_URL!); url.pathname = '/' + database; url.username = role; url.password = password;
    const connection = () => {
      const sql = postgres(url.toString(), { max: 1, connection: { application_name: role, statement_timeout: 10000 } }); clients.push(sql); return sql;
    };
    return { role, sql: connection(), connection };
  }
  const initial = await login('initial'), worker = await login('worker'), ordinary = await login('ordinary');
  const peer = worker.connection();
  // The initial request is not authorization evidence. Its restricted principal
  // accepts only prospective PENDING intent in the same transaction through D02.
  await h.db.sql.unsafe(`grant insert(id,merchant_id,status,capture_method,currency,amount,payment_method_token),select(id) on public.payments to "${initial.role}"`);
  await h.db.sql.unsafe(`grant insert(id,merchant_id,payment_id,kind,amount,currency),select(id) on public.payment_attempts to "${initial.role}"`);
  await h.db.sql.unsafe(`grant insert(aggregate_type,aggregate_id,event_type,payload,available_at),select(id) on public.outbox_events to "${initial.role}"`);
  await h.db.sql.unsafe(`grant insert(id,merchant_id,actor_type,action,target_type,target_id,metadata) on public.audit_logs to "${initial.role}"`);
  await h.db.sql.unsafe(`grant execute on function public.accept_provider_command(uuid,text,text) to "${initial.role}"`);
  await h.db.sql.unsafe(`grant execute on function public.prepare_manual_authorization(uuid,uuid,uuid,integer,bigint,bigint,bigint),
    public.apply_manual_authorization(),public.recognize_manual_authorization(uuid,uuid,uuid),public.claim_manual_authorization(uuid),
    public.fail_manual_authorization(uuid,integer),public.current_financial_application_manifest(),
    public.inspect_receipt_admission(text,text,uuid,text,bigint,bigint) to "${worker.role}"`);
  await h.db.sql.unsafe(`grant execute on function public.publish_admitted_payment_receipt(uuid,text,bytea,text) to "${r.roles.publisher}"`);
  await h.db.sql.unsafe(`grant execute on function public.seal_payment_operation_evidence(uuid,integer,bigint,uuid,uuid),
    public.bind_payment_operation_obligation(uuid,uuid,bigint),public.load_effective_payment_operation_evidence(uuid,integer,text) to "${r.roles.correlator}"`);
  const evidence = new TrustedPaymentOperationEvidence(new RestrictedReceiptDatabase(r.correlator, 'PAYMENT_CORRELATOR'));
  async function install() {
    await h.db.sql`insert into financial_application_contracts(family,phase,policy,version,prepare_function,validate_function)
      values('AUTHORIZE','TERMINAL','LEGACY',1,'public.prepare_manual_authorization(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure,
      'public.validate_manual_authorization(uuid)'::regprocedure)`;
  }
  async function fixture(options: { amount?: number; automatic?: boolean; bind?: boolean; enroll?: boolean; mode?: 'TEST' | 'LIVE'; currency?: string } = {}) {
    const account = `acct_pb_${randomUUID().replaceAll('-', '')}`, merchantId = randomUUID(), paymentId = randomUUID(), attemptId = randomUUID();
    const pi = `pi_${randomUUID().replaceAll('-', '')}`, charge = `ch_${randomUUID().replaceAll('-', '')}`, amount = options.amount ?? 10000, mode = options.mode ?? 'TEST', currency = options.currency ?? 'USD';
    await h.db.sql`insert into financial_evidence_accounts(provider,provider_account,provider_mode) values('STRIPE',${account},${mode})`;
    await h.db.sql`insert into merchants(id,name) values(${merchantId},'P-B isolated initial request')`;
    await h.db.sql`insert into capture_accounting_scopes(merchant_id,currency) values(${merchantId},${currency})`;
    const payload = { merchantId, paymentId, attemptId, amount, currency, paymentMethodToken: 'pm_fixture', idempotencyKey: `authorize:${attemptId}` };
    const outboxId = await initial.sql.begin(async tx => {
      await tx`insert into payments(id,merchant_id,status,capture_method,currency,amount,payment_method_token)
        values(${paymentId},${merchantId},'REQUIRES_AUTHORIZATION',${options.automatic ? 'AUTOMATIC' : 'MANUAL'},${currency},${amount},'pm_fixture')`;
      await tx`insert into payment_attempts(id,merchant_id,payment_id,kind,amount,currency) values(${attemptId},${merchantId},${paymentId},'AUTHORIZE',${amount},${currency})`;
      const id = await new OutboxService().add(tx, { aggregateType: 'PAYMENT_ATTEMPT', aggregateId: attemptId, eventType: 'provider.authorization.requested', payload });
      await tx`insert into audit_logs(id,merchant_id,actor_type,action,target_type,target_id,metadata)
        values(${randomUUID()},${merchantId},'SYSTEM','payment.authorization_requested','payment',${paymentId},'{}')`;
      await tx`select public.accept_provider_command(${id},${account},${mode})`; return id;
    });
    const requestId = `req_${attemptId}`;
    const message: ProviderCommandEnvelope = { id: outboxId, aggregateId: attemptId, eventType: 'provider.authorization.requested', payload, createdAt: new Date().toISOString(), correlationId: randomUUID() };
    const object: PaymentObject = { id: pi, object: 'payment_intent', amount, amount_received: 0, amount_capturable: amount, currency: currency.toLowerCase(), latest_charge: charge,
      livemode: mode === 'LIVE', status: 'requires_capture', capture_method: 'manual', metadata: { merchantId, paymentId, authorizeAttemptId: attemptId } };
    async function exchange(value = object, database: ObservationTransactions = h.publication) {
      const transport = new ScriptedStripeHttp(() => ({ body: Buffer.from(JSON.stringify(value)), headers: { 'request-id': requestId } }));
      const producer = new TrustedProviderObservations(database, { account, mode, apiKey: mode === 'TEST' ? 'sk_test_pb_fixture' : 'sk_live_pb_fixture', maxNetworkRetries: 0 }, transport);
      return producer.execute(message);
    }
    const observed = await exchange(), [source] = await observed.publish();
    const receiver = new TrustedSignedReceiptService(new RestrictedReceiptDatabase(r.publisher, 'PAYMENT_PUBLISHER'),
      { account, webhookSecret: r.secret, admissionContract: 'PAYMENT_OPERATION_V2' }, r.stripe);
    const event: PaymentEvent = { id: `evt_${randomUUID()}`, object: 'event', account, api_version: '2026-08-26.dahlia', livemode: mode === 'LIVE',
      created: Math.floor(Date.now() / 1000), type: 'payment_intent.amount_capturable_updated', request: { id: requestId, idempotency_key: payload.idempotencyKey }, data: { object } };
    async function receive(value = event) {
      const raw = Buffer.from(JSON.stringify(value)), signed = h.sign(raw); return receiver.receive(raw, signed.signature);
    }
    const receipt = await receive();
    const sealed = await evidence.seal(receipt.id, 0, '0', source.id, null);
    expect(sealed.state).toBe('SEALED'); const proofId = sealed.proof_id!;
    if (options.bind !== false) await evidence.bind(receipt.id, proofId, '0');
    async function enroll() {
      await h.db.sql`insert into financial_application_scope_authority values(${merchantId},${currency},'STRIPE',${account},'LEGACY',0,'DORMANT')`;
    }
    if (options.enroll !== false) await enroll();
    return { account, merchantId, paymentId, attemptId, outboxId, pi, charge, amount, currency, payload, message, object, event, sourceId: source.id,
      inboxId: receipt.id, proofId, observed, exchange, receive, receiver, enroll };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function revisions(f: Fixture) {
    const [row] = await h.db.sql<{ obligation: string; scope: string; intake: string }[]>`select
      (select obligation_revision::text from receipt_admission_obligations where inbox_id=${f.inboxId}) obligation,
      (select evidence_revision::text from capture_accounting_scopes where merchant_id=${f.merchantId} and currency=${f.currency}) scope,
      (select evidence_revision::text from receipt_intake_authority where provider='STRIPE' and provider_account=${f.account}) intake`;
    return row;
  }
  async function claim(f: Fixture, sql = worker.sql) {
    const [row] = await sql`select public.claim_manual_authorization(${f.inboxId}) generation`; return row.generation as number | null;
  }
  const prepare = (tx: TransactionSql, f: Fixture, generation: number, rev: Awaited<ReturnType<typeof revisions>>) =>
    tx<{ id: string }[]>`select public.prepare_manual_authorization(${f.outboxId},${f.inboxId},${f.proofId},${generation},${rev.obligation},${rev.scope},${rev.intake}) id`;
  const apply = (tx: TransactionSql) => tx<{ id: string }[]>`select public.apply_manual_authorization() id`;
  const recognize = (f: Fixture, sql = worker.sql) => sql.begin(tx => tx<{ id: string }[]>`select public.recognize_manual_authorization(${f.outboxId},${f.inboxId},${f.proofId}) id`);
  const inspect = (f: Fixture, sql = worker.sql) => sql.begin(tx => tx`select * from public.inspect_receipt_admission('STRIPE',${f.account},${f.merchantId},${f.currency},null,null)`);
  async function complete(f: Fixture, sql = worker.sql) {
    const generation = await claim(f, sql); if (generation === null) throw new Error('P-B test claim unavailable');
    const rev = await revisions(f); return sql.begin(async tx => { await prepare(tx, f, generation, rev); return apply(tx); });
  }
  return { ...h, evidence, initial, worker, peer, ordinary, login, install, fixture, revisions, claim, prepare, apply, recognize, inspect, complete,
    async close(expectedMigrations = 16) { for (const sql of clients) await sql.end(); await h.close(expectedMigrations); } };
}
