import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { ProviderCommandEnvelope } from '../rabbitmq/rabbitmq.types';
import type { ProviderOperation, ProviderOperationInput } from './payment-provider.types';
import { StripePaymentProvider } from './stripe-payment.provider';
import { ObservedStripeTransport, type CapturedExchange, type StripeHttpClient } from './observed-stripe-transport';
import type { ObservationTransactions } from './provider-observation-database';

interface Authority {
  outbox_id: string; provider_account: string; provider_mode: string; operation: ProviderOperation; operation_id: string;
  payment_id: string; merchant_id: string; currency: string; amount: string; command_key: string;
  command_payload: { paymentMethodToken?: string; providerPaymentId?: string; finalCapture?: boolean };
}
interface Lookup { objectId: string; priorSourceId: string | null; reconciliationRunId: string; actor: string }
export interface ObservationPublication { id: string; observation_kind: string; normalized_outcome: Record<string, unknown> }
export interface PendingObservation {
  readonly executionId: string | null;
  // A failed publication keeps these captured bytes in the closure. Calling
  // publish again never invokes Stripe; loss of this process requires a new
  // same-key execution or an explicitly sourced lookup/review.
  publish(): Promise<ObservationPublication[]>;
}
export interface ObservationProviderConfig { apiKey: string; account: string; mode: 'TEST' | 'LIVE'; maxNetworkRetries: 0 | 1 | 2 }

export class TrustedProviderObservations {
  private readonly transport: ObservedStripeTransport;
  private readonly provider: StripePaymentProvider;
  private readonly account: string;
  private readonly mode: 'TEST' | 'LIVE';
  constructor(private readonly database: ObservationTransactions, config: ObservationProviderConfig, http: StripeHttpClient = Stripe.createNodeHttpClient()) {
    if (!/^acct_[A-Za-z0-9_]+$/.test(config.account) || !config.apiKey.startsWith(config.mode === 'TEST' ? 'sk_test_' : 'sk_live_')) throw new Error('Explicit provider account/mode required');
    this.account = config.account; this.mode = config.mode;
    this.transport = new ObservedStripeTransport(http);
    this.provider = new StripePaymentProvider(new Stripe(config.apiKey, { stripeAccount: this.account, httpClient: this.transport,
      maxNetworkRetries: config.maxNetworkRetries, timeout: 15000, telemetry: false }));
  }

  async execute(message: ProviderCommandEnvelope): Promise<PendingObservation> {
    const executionId = randomUUID();
    const { authority, safeUntil } = await this.database.transaction(async tx => {
      const [authority] = await tx<Authority[]>`select * from public.prepare_provider_execution(${executionId},${message.id},${this.account},${this.mode},
        ${tx.json(message.payload as never)},${message.eventType},${message.aggregateId})`;
      if (!authority) throw new Error('Accepted command required');
      const [window] = await tx<{ safe_until: Date }[]>`select min(prepared_at)+interval '23 hours' safe_until from public.provider_command_executions where outbox_id=${message.id}`;
      return { authority, safeUntil: window.safe_until.getTime() };
    });
    const input: ProviderOperationInput = { merchantId: authority.merchant_id, paymentId: authority.payment_id,
      attemptId: authority.operation === 'REFUND' ? undefined : authority.operation_id,
      refundId: authority.operation === 'REFUND' ? authority.operation_id : undefined,
      amount: Number(authority.amount), currency: authority.currency, idempotencyKey: authority.command_key,
      paymentMethodToken: authority.command_payload.paymentMethodToken, providerPaymentId: authority.command_payload.providerPaymentId,
      finalCapture: authority.command_payload.finalCapture };
    const exchanges: CapturedExchange[] = [];
    try {
      await this.transport.capture({ exchanges, account: this.account, key: authority.command_key, safeUntil }, () =>
        authority.operation === 'AUTHORIZE' ? this.provider.authorize(input) : authority.operation === 'CAPTURE' ? this.provider.capture(input)
          : authority.operation === 'REFUND' ? this.provider.refund(input) : this.provider.cancel(input));
    } catch (error) { if (!exchanges.length) throw error; }
    return this.pending(authority.outbox_id, executionId, exchanges);
  }

  async lookup(outboxId: string, lookup: Lookup): Promise<PendingObservation> {
    lookup = { ...lookup };
    const authority = await this.database.transaction(async tx => {
      const [a] = await tx<Authority[]>`select * from public.provider_command_authorities where outbox_id=${outboxId} and provider_account=${this.account} and provider_mode=${this.mode}`;
      const [owned] = await tx<{ safe: boolean }[]>`select exists(select 1 from public.reconciliation_runs where id=${lookup.reconciliationRunId})
        and (exists(select 1 from public.provider_observation_sources where id=${lookup.priorSourceId} and outbox_id=${outboxId})
          or (${lookup.priorSourceId}::uuid is null and exists(select 1 from public.provider_command_executions where outbox_id=${outboxId})))
        and (${lookup.objectId}= (select command_payload->>'providerPaymentId' from public.provider_command_authorities where outbox_id=${outboxId} and operation in ('CAPTURE','VOID'))
          or exists(select 1 from public.provider_observation_sources where id=${lookup.priorSourceId} and outbox_id=${outboxId} and normalized_outcome->>'object_id'=${lookup.objectId})) as safe`;
      if (!a || !owned?.safe || !lookup.actor.trim()) throw new Error('Explicit owned reconciliation target required');
      return a;
    });
    const exchanges: CapturedExchange[] = [];
    try {
      await this.transport.capture({ exchanges, account: this.account, safeUntil: Infinity }, () => this.provider.fetchStatus({
        objectType: authority.operation === 'REFUND' ? 'REFUND' : 'PAYMENT_INTENT', providerObjectId: lookup.objectId }));
    } catch (error) { if (!exchanges.length) throw error; }
    return this.pending(outboxId, null, exchanges, lookup);
  }

  private pending(outboxId: string, executionId: string | null, exchanges: CapturedExchange[], lookup?: Lookup): PendingObservation {
    const batch = randomUUID();
    return Object.freeze({ executionId, publish: () => this.database.transaction(async tx => {
      const result: ObservationPublication[] = [];
      for (const [index, exchange] of exchanges.entries()) {
        const { body, completeness, observedAt, ...context } = exchange;
        const [source] = await tx<ObservationPublication[]>`select * from public.publish_provider_observation(${outboxId},${this.account},${this.mode},
          ${lookup ? 'PROVIDER_LOOKUP' : 'COMMAND_RESULT'},${`${executionId ?? batch}:${index + 1}`},${executionId},${lookup?.objectId ?? null},
          ${lookup?.reconciliationRunId ?? null},${lookup?.actor ?? null},${lookup?.priorSourceId ?? null},${tx.json(context)},${body},${completeness},${Stripe.PACKAGE_VERSION},${observedAt})`;
        result.push(source);
      }
      return result;
    }) });
  }
}
