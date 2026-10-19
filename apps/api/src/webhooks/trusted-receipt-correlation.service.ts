import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../common/domain-error';
import { TRUSTED_RECEIPT_CORRELATOR, TRUSTED_RECEIPT_ENDPOINT, type ReceiptTransactions, type TrustedReceiptEndpoint } from './trusted-receipt-database';

interface CorrelationSource { attempts: number; operation: string; provider_account: string; observation_id: string | null }
interface Proof { proof_revision: number; merchant_id: string; payment_id: string; currency: string }

// Internal isolated composition only. Consumes already retained immutable D02
// sources; performs no lookup/network request or observation publication.
@Injectable()
export class TrustedReceiptCorrelationService {
  private readonly account: string;
  constructor(
    @Inject(TRUSTED_RECEIPT_CORRELATOR) private readonly database: ReceiptTransactions,
    @Inject(TRUSTED_RECEIPT_ENDPOINT) endpoint: TrustedReceiptEndpoint,
  ) { this.account = endpoint.account; }

  async correlate(inboxId: string) {
    let source: CorrelationSource | undefined;
    try {
      const proof = await this.database.transaction(async tx => {
        [source] = await tx<CorrelationSource[]>`select w.attempts,a.operation,a.provider_account,
          (select o.id from public.provider_financial_observations o where o.provider=a.provider and o.provider_account=a.provider_account
            and o.source_kind='COMMAND_RESULT' and o.object_kind='REFUND'
            and o.provider_object_id=r.normalized_payload#>>'{data,providerTransactionId}' order by o.id limit 1) as observation_id
          from public.webhook_events w join public.receipt_admissions a on a.inbox_id=w.id
          join public.provider_financial_receipts r on r.inbox_id=w.id where w.id=${inboxId}`;
        if (!source || source.provider_account !== this.account) throw new DomainError('RECEIPT_CONTEXT_REQUIRED', 'Admitted receipt for configured account required', 409);
        if (!['refund.succeeded', 'refund.failed', 'dispute.opened', 'dispute.closed'].includes(source.operation)) return null;
        const [sealed] = await tx<Proof[]>`select proof_revision,merchant_id,payment_id,currency from
          public.seal_financial_correlation(${inboxId},${source.attempts},${source.operation.startsWith('refund.') ? source.observation_id : null})`;
        return sealed;
      });
      if (!proof) return { state: 'NOT_SEALABLE' as const };
      // The first transaction ends before binding. Until binding commits the
      // original unknown-owner obligation still blocks; partial progress is safe.
      await this.database.transaction(tx => tx`select public.bind_receipt_obligation(${inboxId},${proof.proof_revision})`);
      return { state: 'BOUND' as const, proofRevision: proof.proof_revision, merchantId: proof.merchant_id, paymentId: proof.payment_id, currency: proof.currency };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!source || !['P0001', 'P0002'].includes(code ?? '')) throw error;
      await this.database.transaction(tx => tx`insert into public.financial_evidence_reviews(inbox_id,review_key,reason,observations)
        values(${inboxId},${`r1/correlation/${source!.attempts}/${code}`},'UNRESOLVED',
          ${tx.json({ contract: 'R1_RECEIPT_V1', dependency: 'TRUSTED_CORRELATION', sqlState: code! })}) on conflict(inbox_id,review_key) do nothing`);
      return { state: 'UNRESOLVED' as const, dependency: 'TRUSTED_CORRELATION' as const };
    }
  }
}
