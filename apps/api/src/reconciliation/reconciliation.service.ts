import { Inject, Injectable } from '@nestjs/common';
import type { AuthActor } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';
import { PAYMENT_PROVIDER, PaymentProvider, ProviderReportRow } from '../payment-provider/payment-provider.types';

interface InternalCapture { payment_id: string; merchant_id: string; payment_status: string; attempt_status: string; provider_transaction_id: string | null; amount: string; currency: string }

@Injectable()
export class ReconciliationService {
  constructor(private readonly database: DatabaseService, @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider, private readonly audit: AuditService) {}

  async run(): Promise<{ runId: string; issues: number }> {
    const [run] = await this.database.sql<{ id: string }[]>`insert into reconciliation_runs (status) values ('PROCESSING') returning id`;
    try {
      const [providerRows, internalRows] = await Promise.all([
        this.provider.report(),
        this.database.sql<InternalCapture[]>`select a.payment_id, a.merchant_id, p.status as payment_status, a.status as attempt_status, a.provider_transaction_id, a.amount::text, a.currency from payment_attempts a join payments p on p.id=a.payment_id where a.kind='CAPTURE'`,
      ]);
      const byProviderId = new Map(internalRows.filter((row) => row.provider_transaction_id).map((row) => [row.provider_transaction_id as string, row]));
      const providerIds = new Set(providerRows.map((row) => row.providerTransactionId));
      const internalByPayment = new Map<string, InternalCapture[]>();
      for (const row of internalRows) internalByPayment.set(row.payment_id, [...(internalByPayment.get(row.payment_id) ?? []), row]);
      const providerCaptureByPayment = new Map<string, ProviderReportRow[]>();
      for (const row of providerRows.filter((item) => item.operation === 'CAPTURE')) {
        if (row.paymentId) providerCaptureByPayment.set(row.paymentId, [...(providerCaptureByPayment.get(row.paymentId) ?? []), row]);
        const internal = byProviderId.get(row.providerTransactionId);
        if (!internal) await this.issue(run.id, row.merchantId, row.paymentId, row.providerTransactionId, 'UNKNOWN_PROVIDER_TRANSACTION', 'HIGH', {}, row);
        else if (Number(internal.amount) !== row.amount || internal.currency !== row.currency) await this.issue(run.id, internal.merchant_id, internal.payment_id, row.providerTransactionId, 'AMOUNT_OR_CURRENCY_MISMATCH', 'CRITICAL', internal, row);
        else if (row.status === 'CAPTURED' && internal.payment_status === 'CAPTURE_PENDING') await this.issue(run.id, internal.merchant_id, internal.payment_id, row.providerTransactionId, 'PROVIDER_CAPTURED_INTERNAL_PENDING', 'HIGH', internal, row);
      }
      for (const internal of internalRows) {
        if (internal.attempt_status === 'SUCCEEDED' && (!internal.provider_transaction_id || !providerIds.has(internal.provider_transaction_id))) {
          await this.issue(run.id, internal.merchant_id, internal.payment_id, internal.provider_transaction_id, 'INTERNAL_CAPTURE_MISSING_PROVIDER', 'CRITICAL', internal, {});
        }
      }
      for (const [paymentId, rows] of providerCaptureByPayment) if (rows.length > (internalByPayment.get(paymentId)?.length ?? 0)) await this.issue(run.id, rows[0].merchantId, paymentId, null, 'DUPLICATE_PROVIDER_CAPTURE', 'CRITICAL', internalByPayment.get(paymentId) ?? [], rows);
      const [count] = await this.database.sql<{ total: string }[]>`select count(*)::text as total from reconciliation_issues where run_id=${run.id}`;
      const issues = Number(count.total);
      await this.database.sql`update reconciliation_runs set status='SUCCEEDED', completed_at=now(), summary=${this.database.sql.json({ providerRows: providerRows.length, internalRows: internalRows.length, issues })} where id=${run.id}`;
      return { runId: run.id, issues };
    } catch (error) {
      await this.database.sql`update reconciliation_runs set status='FAILED', completed_at=now(), summary=${this.database.sql.json({ error: error instanceof Error ? error.message : 'unknown' })} where id=${run.id}`;
      throw error;
    }
  }

  list(actor: AuthActor) {
    const merchantId = actor.role === 'PLATFORM_ADMIN' ? null : actor.merchantId;
    return this.database.sql`select id, run_id as "runId", merchant_id as "merchantId", payment_id as "paymentId", provider_transaction_id as "providerTransactionId", issue_type as "issueType", severity, status, internal_snapshot as "internalSnapshot", provider_snapshot as "providerSnapshot", resolution_note as "resolutionNote", created_at as "createdAt", resolved_at as "resolvedAt" from reconciliation_issues where (${merchantId}::uuid is null or merchant_id=${merchantId}) order by created_at desc limit 200`;
  }

  async resolve(actor: AuthActor, issueId: string, note: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [issue] = await tx<{ merchant_id: string | null; status: string }[]>`select merchant_id, status from reconciliation_issues where id=${issueId} for update`;
      if (!issue || (actor.role !== 'PLATFORM_ADMIN' && issue.merchant_id !== actor.merchantId)) throw new DomainError('RECONCILIATION_ISSUE_NOT_FOUND', 'Reconciliation issue was not found', 404);
      await tx`update reconciliation_issues set status='RESOLVED', resolution_note=${note}, resolved_by=${actor.type === 'USER' ? actor.id : null}, resolved_at=now() where id=${issueId}`;
      await this.audit.append(tx, { merchantId: issue.merchant_id, actor, action: 'reconciliation.resolved', targetType: 'reconciliation_issue', targetId: issueId, metadata: { note } });
    });
  }

  private async issue(runId: string, merchantId: string | null, paymentId: string | null, providerTransactionId: string | null, issueType: string, severity: string, internal: unknown, provider: unknown): Promise<void> {
    await this.database.sql`insert into reconciliation_issues (run_id, merchant_id, payment_id, provider_transaction_id, issue_type, severity, internal_snapshot, provider_snapshot) values (${runId}, ${merchantId}, ${paymentId}, ${providerTransactionId}, ${issueType}, ${severity}, ${this.database.sql.json(internal as never)}, ${this.database.sql.json(provider as never)}`;
  }
}
