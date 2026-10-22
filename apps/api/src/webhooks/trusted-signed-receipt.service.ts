import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { DomainError } from '../common/domain-error';
import { STRIPE_CLIENT } from '../payment-provider/payment-provider.types';
import { normalizeStripeEvent } from './stripe-event.normalizer';
import type { ProviderEvent } from './webhook.types';
import { TRUSTED_RECEIPT_ENDPOINT, TRUSTED_RECEIPT_PUBLISHER, type ReceiptTransactions, type TrustedReceiptEndpoint } from './trusted-receipt-database';

type ReceiptHeaders = Record<string, string | string[] | undefined>;
export interface SignedReceiptResult {
  id: string;
  duplicate: boolean;
  classification: 'ORIGINAL' | 'EQUIVALENT' | 'CONFLICT';
  deliveryId?: string;
}

// Deliberately absent from WebhooksModule and every live controller/worker.
@Injectable()
export class TrustedSignedReceiptService {
  private readonly endpoint: Readonly<TrustedReceiptEndpoint>;
  private readonly verifier = `stripe-node/${Stripe.PACKAGE_VERSION};R1_RECEIPT_V1`;

  constructor(
    @Inject(TRUSTED_RECEIPT_PUBLISHER) private readonly database: ReceiptTransactions,
    @Inject(TRUSTED_RECEIPT_ENDPOINT) endpoint: TrustedReceiptEndpoint,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
  ) {
    if (!endpoint.account?.trim() || !endpoint.webhookSecret?.trim()) throw new Error('Explicit trusted Stripe endpoint configuration required');
    this.endpoint = Object.freeze({ ...endpoint });
  }

  async receive(rawBody: Buffer | undefined, signature: string, headers: ReceiptHeaders = {}): Promise<SignedReceiptResult> {
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) throw new DomainError('RAW_BODY_REQUIRED', 'Exact raw webhook bytes are required', 400);
    if (typeof signature !== 'string' || !signature || (headers['stripe-signature'] !== undefined && headers['stripe-signature'] !== signature)) {
      throw new DomainError('INVALID_WEBHOOK_SIGNATURE', 'Stripe webhook signature verification failed', 400);
    }
    const raw = Buffer.from(rawBody), retainedHeaders = structuredClone({ ...headers, 'stripe-signature': signature });
    let event: Stripe.Event;
    try { event = this.stripe.webhooks.constructEvent(raw, signature, this.endpoint.webhookSecret); }
    catch { throw new DomainError('INVALID_WEBHOOK_SIGNATURE', 'Stripe webhook signature verification failed', 400); }
    if (!event.id || typeof event.id !== 'string' || !event.type || typeof event.type !== 'string') {
      throw new DomainError('INVALID_PROVIDER_EVENT', 'Verified event identity is required', 400);
    }
    if (event.account !== undefined && event.account !== this.endpoint.account) {
      throw new DomainError('PROVIDER_ACCOUNT_MISMATCH', 'Signed account differs from configured endpoint context', 400);
    }
    let normalized: ProviderEvent;
    try { normalized = normalizeStripeEvent(event); }
    catch { throw new DomainError('INVALID_PROVIDER_EVENT', 'Verified event cannot be normalized under receipt version1', 400); }
    return this.database.transaction(async tx => {
      const [inserted] = await tx<{ id: string }[]>`insert into public.webhook_events
        (provider,provider_event_id,event_type,signature,payload,headers)
        values('STRIPE',${event.id},${normalized.type},${signature},${tx.json(normalized as never)},${tx.json(retainedHeaders)})
        on conflict(provider,provider_event_id) do nothing returning id`;
      if (inserted) {
        if (this.endpoint.admissionContract === 'PAYMENT_OPERATION_V2') {
          await tx`select public.publish_admitted_payment_receipt(${inserted.id},${this.endpoint.account},${raw},${this.verifier})`;
        } else await tx`select public.publish_admitted_receipt(${inserted.id},${this.endpoint.account},${raw},${this.verifier})`;
        return { id: inserted.id, duplicate: false, classification: 'ORIGINAL' };
      }
      // A separate READ COMMITTED statement sees the winner after the unique
      // index wait. No failed transaction or stale CTE snapshot is reused.
      const [existing] = await tx<{ id: string; admitted: boolean }[]>`select w.id,
        exists(select 1 from public.provider_financial_receipts r join public.receipt_admissions a on a.inbox_id=r.inbox_id
          where r.inbox_id=w.id) as admitted from public.webhook_events w where provider='STRIPE' and provider_event_id=${event.id}`;
      if (!existing?.admitted) throw new DomainError('HISTORICAL_RECEIPT_REVIEW_REQUIRED', 'Existing inbox identity requires reviewed trusted admission', 409);
      const [delivery] = await tx<{ id: string; classification: 'EQUIVALENT' | 'CONFLICT' }[]>`select id,classification from
        public.publish_verified_receipt_delivery(${existing.id},${this.endpoint.account},${raw},${signature},
          ${tx.json(retainedHeaders)},${tx.json(normalized as never)},${this.verifier})`;
      return { id: existing.id, duplicate: true, classification: delivery.classification, deliveryId: delivery.id };
    });
  }
}
