import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthActor } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import { IdempotencyService, IdempotentResult } from '../common/idempotency.service';
import { DatabaseService, DbTransaction } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { CreatePayoutDto } from './payouts.dto';

@Injectable()
export class PayoutsService {
  constructor(private readonly database: DatabaseService, private readonly idempotency: IdempotencyService, private readonly ledger: LedgerService, private readonly outbox: OutboxService, private readonly audit: AuditService) {}

  request(actor: AuthActor, key: string, dto: CreatePayoutDto): Promise<IdempotentResult<Record<string, unknown>>> {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'A merchant context is required', 403);
    const merchantId = actor.merchantId;
    return this.idempotency.execute({ merchantId, operation: 'payout.create', key, payload: dto, responseStatus: 202, action: async (tx) => {
      // Cross-process lock: every balance-consuming operation for this merchant/currency must use this key.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${merchantId}:${dto.currency}`}, 0))`;
      const available = await this.ledger.merchantBalance(tx, merchantId, dto.currency, 'MERCHANT_AVAILABLE');
      if (available < dto.amount) throw new DomainError('INSUFFICIENT_AVAILABLE_BALANCE', 'Payout exceeds available balance', 409, { available });
      const payoutId = randomUUID();
      await tx`insert into payouts (id, merchant_id, amount, currency, destination_token) values (${payoutId}, ${merchantId}, ${dto.amount}, ${dto.currency}, ${dto.destinationToken})`;
      await this.ledger.post(tx, { merchantId, businessType: 'PAYOUT_RESERVATION', businessId: payoutId, currency: dto.currency, description: `Reserve payout ${payoutId}`, lines: [
        { accountCode: 'MERCHANT_AVAILABLE', merchantId, debit: dto.amount }, { accountCode: 'PAYOUT_CLEARING', merchantId, credit: dto.amount },
      ]});
      await this.outbox.add(tx, { aggregateType: 'PAYOUT', aggregateId: payoutId, eventType: 'payout.process', payload: { merchantId, payoutId, amount: dto.amount, currency: dto.currency } });
      await this.audit.append(tx, { merchantId, actor, action: 'payout.requested', targetType: 'payout', targetId: payoutId, metadata: { amount: dto.amount, currency: dto.currency } });
      return { id: payoutId, status: 'PENDING', amount: dto.amount, currency: dto.currency };
    }});
  }

  async complete(tx: DbTransaction, payoutId: string): Promise<void> {
    const [payout] = await tx<{ id: string; merchant_id: string; status: string; amount: string; currency: string }[]>`select id, merchant_id, status, amount::text, currency from payouts where id=${payoutId} for update`;
    if (!payout) throw new DomainError('PAYOUT_NOT_FOUND', 'Payout was not found', 404);
    if (payout.status === 'SUCCEEDED') return;
    const amount = Number(payout.amount);
    await this.ledger.post(tx, { merchantId: payout.merchant_id, businessType: 'PAYOUT_COMPLETION', businessId: payoutId, currency: payout.currency, description: `Complete payout ${payoutId}`, lines: [
      { accountCode: 'PAYOUT_CLEARING', merchantId: payout.merchant_id, debit: amount }, { accountCode: 'PLATFORM_CASH', merchantId: null, credit: amount },
    ]});
    await tx`update payouts set status='SUCCEEDED', provider_reference=${`mock_payout_${payoutId}`}, completed_at=now(), updated_at=now() where id=${payoutId}`;
  }

  list(actor: AuthActor) {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'A merchant context is required', 403);
    return this.database.sql`select id, status, amount::text, currency, provider_reference as "providerReference", failure_code as "failureCode", created_at as "createdAt", completed_at as "completedAt" from payouts where merchant_id=${actor.merchantId} order by created_at desc`;
  }
}
