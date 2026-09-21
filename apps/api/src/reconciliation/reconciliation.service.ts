import { Inject, Injectable } from '@nestjs/common';
import type { AuthActor } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';
import { PAYMENT_PROVIDER, PaymentProvider, ProviderStatus } from '../payment-provider/payment-provider.types';

interface InternalCapture { payment_id: string; merchant_id: string; payment_status: string; attempt_status: string; provider_transaction_id: string | null; amount: string; currency: string; payment_amount: string; captured_amount: string }

@Injectable()
export class ReconciliationService {
  constructor(private readonly database: DatabaseService, @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider, private readonly audit: AuditService) {}

  async run(): Promise<{ runId: string; issues: number }> {
    const [run] = await this.database.sql<{ id: string }[]>`insert into reconciliation_runs (status) values ('PROCESSING') returning id`;
    try {
      const internalRows = await this.database.sql<InternalCapture[]>`
        select a.payment_id, a.merchant_id, p.status as payment_status, a.status as attempt_status,
          a.provider_transaction_id, a.amount::text, a.currency, p.amount::text as payment_amount,
          p.captured_amount::text as captured_amount
        from payment_attempts a join payments p on p.id=a.payment_id where a.kind='CAPTURE'`;
      const byProviderId = new Map<string, InternalCapture[]>();
      for (const row of internalRows) {
        if (!row.provider_transaction_id) {
          if (row.attempt_status === 'SUCCEEDED') await this.issue(run.id, row.merchant_id, row.payment_id, null, 'INTERNAL_CAPTURE_MISSING_PROVIDER_REFERENCE', 'CRITICAL', row, {});
          continue;
        }
        byProviderId.set(row.provider_transaction_id, [...(byProviderId.get(row.provider_transaction_id) ?? []), row]);
      }
      for (const [providerObjectId, rows] of byProviderId) {
        const providerState = await this.provider.fetchStatus({ objectType: 'PAYMENT_INTENT', providerObjectId });
        await this.compareProviderState(run.id, providerObjectId, rows, providerState);
      }
      const [count] = await this.database.sql<{ total: string }[]>`select count(*)::text as total from reconciliation_issues where run_id=${run.id}`;
      const issues = Number(count.total);
      await this.database.sql`update reconciliation_runs set status='SUCCEEDED', completed_at=now(), summary=${this.database.sql.json({ providerQueries: byProviderId.size, internalRows: internalRows.length, issues })} where id=${run.id}`;
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

  private async compareProviderState(runId: string, providerObjectId: string, rows: InternalCapture[], provider: ProviderStatus | null): Promise<void> {
    const internal = rows[0];
    if (!provider) {
      const issueType = rows.some((row) => row.attempt_status === 'SUCCEEDED') ? 'INTERNAL_CAPTURE_MISSING_PROVIDER' : 'PROVIDER_OBJECT_NOT_FOUND';
      await this.issue(runId, internal.merchant_id, internal.payment_id, providerObjectId, issueType, 'CRITICAL', rows, {});
      return;
    }
    if (provider.amount !== Number(internal.payment_amount) || provider.currency !== internal.currency) {
      await this.issue(runId, internal.merchant_id, internal.payment_id, providerObjectId, 'AMOUNT_OR_CURRENCY_MISMATCH', 'CRITICAL', rows, provider);
    }
    if (provider.status === 'succeeded' && internal.payment_status === 'CAPTURE_PENDING') {
      await this.issue(runId, internal.merchant_id, internal.payment_id, providerObjectId, 'PROVIDER_CAPTURED_INTERNAL_PENDING', 'HIGH', rows, provider);
    } else if (rows.some((row) => row.attempt_status === 'SUCCEEDED') && provider.status !== 'succeeded' && provider.status !== 'requires_capture') {
      await this.issue(runId, internal.merchant_id, internal.payment_id, providerObjectId, 'INTERNAL_SUCCEEDED_PROVIDER_NOT_CAPTURED', 'CRITICAL', rows, provider);
    }
    if (internal.payment_status !== 'CAPTURE_PENDING' && provider.capturedAmount !== undefined && provider.capturedAmount !== Number(internal.captured_amount)) {
      await this.issue(runId, internal.merchant_id, internal.payment_id, providerObjectId, 'CAPTURED_AMOUNT_MISMATCH', 'CRITICAL', rows, provider);
    }
  }

  private async issue(runId: string, merchantId: string | null, paymentId: string | null, providerTransactionId: string | null, issueType: string, severity: string, internal: unknown, provider: unknown): Promise<void> {
    await this.database.sql`insert into reconciliation_issues (run_id, merchant_id, payment_id, provider_transaction_id, issue_type, severity, internal_snapshot, provider_snapshot) values (${runId}, ${merchantId}, ${paymentId}, ${providerTransactionId}, ${issueType}, ${severity}, ${this.database.sql.json(internal as never)}, ${this.database.sql.json(provider as never)}`;
  }
}
