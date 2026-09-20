import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthActor } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import { DatabaseService, DbTransaction } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';

interface EligibleCapture { attempt_id: string; payment_id: string; merchant_id: string; currency: string; gross: string; fee: string; net: string; settlement_delay_days: number }

@Injectable()
export class SettlementsService {
  constructor(private readonly database: DatabaseService, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  async generate(merchantId?: string): Promise<string[]> {
    return this.database.transaction(async (tx) => {
      const captures = await tx<EligibleCapture[]>`
        with eligible as materialized (
          select a.id from payment_attempts a join merchants m on m.id=a.merchant_id
          left join settlement_items si on si.capture_attempt_id=a.id
          where a.kind='CAPTURE' and a.status='SUCCEEDED' and si.id is null
            and (${merchantId ?? null}::uuid is null or a.merchant_id=${merchantId ?? null})
            and a.updated_at <= now() - make_interval(days => m.settlement_delay_days)
          order by a.updated_at for update of a skip locked
        )
        select a.id as attempt_id, a.payment_id, a.merchant_id, a.currency,
          max(case when la.code='PSP_CLEARING' then le.debit else 0 end)::text as gross,
          max(case when la.code='PLATFORM_FEE_REVENUE' then le.credit else 0 end)::text as fee,
          max(case when la.code='MERCHANT_PENDING' then le.credit else 0 end)::text as net,
          m.settlement_delay_days
        from payment_attempts a join merchants m on m.id=a.merchant_id
        join ledger_transactions lt on lt.business_type='CAPTURE' and lt.business_id=a.id and lt.status='POSTED'
        join ledger_entries le on le.transaction_id=lt.id join ledger_accounts la on la.id=le.account_id
        join eligible on eligible.id=a.id
        group by a.id, a.payment_id, a.merchant_id, a.currency, m.settlement_delay_days
        `;
      const groups = new Map<string, EligibleCapture[]>();
      for (const capture of captures) {
        const key = `${capture.merchant_id}:${capture.currency}`;
        groups.set(key, [...(groups.get(key) ?? []), capture]);
      }
      const ids: string[] = [];
      for (const items of groups.values()) {
        const id = randomUUID();
        const gross = items.reduce((sum, item) => sum + Number(item.gross), 0);
        const fee = items.reduce((sum, item) => sum + Number(item.fee), 0);
        const net = items.reduce((sum, item) => sum + Number(item.net), 0);
        await tx`insert into settlements (id, merchant_id, currency, gross_amount, fee_amount, net_amount, available_on) values (${id}, ${items[0].merchant_id}, ${items[0].currency}, ${gross}, ${fee}, ${net}, now())`;
        for (const item of items) await tx`insert into settlement_items (settlement_id, payment_id, capture_attempt_id, gross_amount, fee_amount, net_amount, currency) values (${id}, ${item.payment_id}, ${item.attempt_id}, ${Number(item.gross)}, ${Number(item.fee)}, ${Number(item.net)}, ${item.currency}) on conflict do nothing`;
        ids.push(id);
      }
      return ids;
    });
  }

  async complete(tx: DbTransaction, settlementId: string): Promise<void> {
    const [settlement] = await tx<{ id: string; merchant_id: string; currency: string; status: string; gross_amount: string; net_amount: string }[]>`select id, merchant_id, currency, status, gross_amount::text, net_amount::text from settlements where id=${settlementId} for update`;
    if (!settlement) throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found', 404);
    if (settlement.status === 'SUCCEEDED') return;
    const gross = Number(settlement.gross_amount); const net = Number(settlement.net_amount);
    await this.ledger.post(tx, { merchantId: settlement.merchant_id, businessType: 'SETTLEMENT', businessId: settlement.id, currency: settlement.currency, description: `Settlement ${settlement.id}`, lines: [
      { accountCode: 'PLATFORM_CASH', merchantId: null, debit: gross }, { accountCode: 'PSP_CLEARING', merchantId: null, credit: gross },
      { accountCode: 'MERCHANT_PENDING', merchantId: settlement.merchant_id, debit: net }, { accountCode: 'MERCHANT_AVAILABLE', merchantId: settlement.merchant_id, credit: net },
    ]});
    await tx`update settlements set status='SUCCEEDED', provider_reference=${`mock_settlement_${settlementId}`}, completed_at=now(), updated_at=now() where id=${settlementId}`;
    await this.audit.append(tx, { merchantId: settlement.merchant_id, actor: { type: 'SYSTEM' }, action: 'settlement.completed', targetType: 'settlement', targetId: settlementId, metadata: { gross, net, currency: settlement.currency } });
  }

  async completeDue(): Promise<number> {
    const rows = await this.database.sql<{ id: string }[]>`select id from settlements where status='PENDING' and available_on <= now() order by created_at limit 100`;
    for (const row of rows) await this.database.transaction((tx) => this.complete(tx, row.id));
    return rows.length;
  }

  async completeForMerchant(settlementId: string, merchantId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [owned] = await tx<{ id: string }[]>`select id from settlements where id=${settlementId} and merchant_id=${merchantId}`;
      if (!owned) throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found', 404);
      await this.complete(tx, settlementId);
    });
  }

  list(actor: AuthActor) {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'A merchant context is required', 403);
    return this.database.sql`select id, status, currency, gross_amount::text as "grossAmount", fee_amount::text as "feeAmount", net_amount::text as "netAmount", available_on as "availableOn", completed_at as "completedAt", created_at as "createdAt" from settlements where merchant_id=${actor.merchantId} order by created_at desc`;
  }
}
