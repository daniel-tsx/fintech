import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import postgres, { type Sql } from 'postgres';
import Stripe from 'stripe';
import { OutboxService } from '../../src/outbox/outbox.service';
import { RestrictedObservationDatabase } from '../../src/payment-provider/provider-observation-database';
import { TrustedProviderObservations } from '../../src/payment-provider/trusted-provider-observations';
import type { StripeHttpClient } from '../../src/payment-provider/observed-stripe-transport';
import type { ProviderCommandEnvelope } from '../../src/rabbitmq/rabbitmq.types';
import { trustedEvidenceFixture } from './trusted-evidence-fixtures';
import { trustedReceiptHarness } from './trusted-receipt-harness';

type Arguments = Parameters<StripeHttpClient['makeRequest']>;
export type Reply = { body: Buffer; status?: number; partial?: boolean; headers?: Record<string,string> } | Error;
export class ScriptedStripeHttp extends Stripe.HttpClient {
  readonly calls: Arguments[] = [];
  constructor(private readonly response: (args: Arguments, index: number) => Reply) { super(); }
  getClientName(): string { return 'isolated-provider-fixture'; }
  makeRequest(...args: Arguments): ReturnType<StripeHttpClient['makeRequest']> {
    this.calls.push(args); const reply = this.response(args, this.calls.length - 1);
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(new FixtureResponse(reply));
  }
}
class FixtureResponse extends Stripe.HttpClientResponse {
  constructor(private readonly reply: Exclude<Reply, Error>) { super(reply.status ?? 200, { 'request-id': 'req_d02_fixture', 'content-type': 'application/json', ...reply.headers }); }
  getRawResponse(): unknown { return { fixture: true }; }
  toStream(): Readable {
    const reply = this.reply;
    return Readable.from((function* () { yield reply.body; if (reply.partial) throw Stripe.HttpClient.makeTimeoutError(); })());
  }
  toJSON(): never { throw new Error('Observation wrapper must consume original bytes'); }
}

export async function providerObservationHarness(migrationsFolder?: string) {
  const h = await trustedReceiptHarness(migrationsFolder), role = `d02_pub_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
  await h.db.sql.unsafe(`create role "${role}" login password '${password}' noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  await h.db.sql.unsafe(`grant usage on schema public to "${role}"`);
  await h.db.sql.unsafe(`grant select on provider_command_authorities,provider_command_executions,provider_observation_sources,reconciliation_runs to "${role}"`);
  await h.db.sql.unsafe(`grant execute on function public.prepare_provider_execution(uuid,uuid,text,text,jsonb,text,uuid),public.publish_provider_observation(uuid,text,text,text,text,uuid,text,uuid,text,uuid,jsonb,bytea,text,text,timestamptz) to "${role}"`);
  const [database] = await h.db.sql<{ name: string }[]>`select current_database() as name`;
  const clients: Sql[] = [];
  function connection(label: string) {
    const url = new URL(process.env.MIGRATION_ADMIN_URL!); url.pathname = '/' + database.name; url.username = role; url.password = password;
    const sql = postgres(url.toString(), { max: 1, connection: { application_name: label, statement_timeout: 10000 } }); clients.push(sql); return sql;
  }
  const sql = connection('d02_publisher'), peer = connection('d02_peer');
  const publication = new RestrictedObservationDatabase(sql), peerPublication = new RestrictedObservationDatabase(peer);
  async function accepted(operation: 'REFUND' | 'CAPTURE' | 'AUTHORIZE' | 'VOID' = 'REFUND', shared?: Awaited<ReturnType<typeof trustedEvidenceFixture>>) {
    const account = `acct_d02_${randomUUID().replaceAll('-', '')}`;
    if (!shared) await h.db.sql`insert into financial_evidence_accounts(provider,provider_account,provider_mode) values('STRIPE',${account},'TEST')`;
    const f = shared ?? await trustedEvidenceFixture(h.db, account), id = randomUUID();
    const payload = { merchantId: f.merchantId, paymentId: f.paymentId, amount: 2000, currency: 'USD', providerPaymentId: f.pi,
      paymentMethodToken: 'pm_fixture', ...(operation === 'REFUND' ? { refundId: id } : { attemptId: id }), idempotencyKey: `${operation.toLowerCase()}:${id}` };
    const eventType: ProviderCommandEnvelope['eventType'] = operation === 'REFUND' ? 'provider.refund.requested' : operation === 'CAPTURE' ? 'provider.capture.requested'
      : operation === 'AUTHORIZE' ? 'provider.authorization.requested' : 'provider.void.requested';
    const outboxId = await h.db.transaction(async tx => {
      // Production integration must take this account lock before financial
      // parents. This test composition does not register a new API intent writer.
      await tx`select 1 from financial_evidence_accounts where provider='STRIPE' and provider_account=${f.account} for share`;
      if (operation === 'REFUND') await tx`insert into refunds(id,merchant_id,payment_id,amount,currency) values(${id},${f.merchantId},${f.paymentId},2000,'USD')`;
      else await tx`insert into payment_attempts(id,merchant_id,payment_id,kind,amount,currency) values(${id},${f.merchantId},${f.paymentId},${operation},2000,'USD')`;
      const outboxId = await new OutboxService().add(tx, { aggregateType: operation === 'REFUND' ? 'REFUND' : 'PAYMENT_ATTEMPT', aggregateId: id, eventType, payload });
      await tx`select public.accept_provider_command(${outboxId},${f.account},'TEST')`;
      return outboxId;
    });
    const message: ProviderCommandEnvelope = { id: outboxId, aggregateId: id, eventType, payload, createdAt: new Date().toISOString(), correlationId: randomUUID() };
    const object = operation === 'REFUND' ? { id: `re_${id}`, object: 'refund', payment_intent: f.pi, charge: f.charge, amount: 2000, currency: 'usd', livemode: false, status: 'succeeded', metadata: { merchantId: f.merchantId, paymentId: f.paymentId, refundId: id } }
      : { id: f.pi, object: 'payment_intent', latest_charge: f.charge, amount: 10000, amount_received: 2000, currency: 'usd', livemode: false,
        status: operation === 'VOID' ? 'canceled' : operation === 'AUTHORIZE' ? 'requires_capture' : 'succeeded', metadata: { merchantId: f.merchantId, paymentId: f.paymentId } };
    if (operation === 'AUTHORIZE') object.amount = 2000;
    const raw = Buffer.from(' \n' + JSON.stringify(object, null, 2) + '\n');
    const transport = new ScriptedStripeHttp(() => ({ body: raw }));
    const producer = new TrustedProviderObservations(publication, { account: f.account, mode: 'TEST', apiKey: 'sk_test_d02_fixture', maxNetworkRetries: 0 }, transport);
    return { ...f, operationId: id, outboxId, message, object, raw, transport, producer };
  }
  return { receipt: h, db: h.db, sign: h.sign, receiver: h.receiver, correlate: h.correlate, read: h.read,
    observationRole: role, observationSql: sql, observationPeer: peer, publication, peerPublication, accepted,
    async close(expectedMigrations = 14) { for (const client of clients) await client.end(); await h.close(expectedMigrations); } };
}
