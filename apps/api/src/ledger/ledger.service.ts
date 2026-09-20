import { Injectable } from '@nestjs/common';
import type { DbTransaction } from '../database/database.service';
import { DatabaseService } from '../database/database.service';
import { assertBalanced, JournalInput, LedgerAccountCode } from './ledger.types';

const ACCOUNT_TYPES: Record<LedgerAccountCode, string> = {
  PSP_CLEARING: 'ASSET', PLATFORM_CASH: 'ASSET', MERCHANT_PENDING: 'LIABILITY', MERCHANT_AVAILABLE: 'LIABILITY',
  PLATFORM_FEE_REVENUE: 'REVENUE', PLATFORM_FEE_REFUNDS: 'EXPENSE', PAYOUT_CLEARING: 'LIABILITY', DISPUTE_CLEARING: 'LIABILITY',
};

@Injectable()
export class LedgerService {
  constructor(private readonly database: DatabaseService) {}

  async post(tx: DbTransaction, input: JournalInput): Promise<string> {
    assertBalanced(input.lines);
    const inserted = await tx<{ id: string }[]>`
      insert into ledger_transactions (merchant_id, business_type, business_id, currency, description)
      values (${input.merchantId}, ${input.businessType}, ${input.businessId}, ${input.currency}, ${input.description})
      on conflict (business_type, business_id, currency) do nothing returning id`;
    if (inserted.length === 0) {
      const [existing] = await tx<{ id: string }[]>`select id from ledger_transactions where business_type = ${input.businessType} and business_id = ${input.businessId} and currency = ${input.currency}`;
      if (!existing) throw new Error('Existing ledger transaction disappeared');
      return existing.id;
    }
    const transactionId = inserted[0].id;
    for (const line of input.lines) {
      await tx`
        insert into ledger_accounts (merchant_id, code, account_type, currency, name)
        values (${line.merchantId}, ${line.accountCode}, ${ACCOUNT_TYPES[line.accountCode]}, ${input.currency}, ${line.accountCode.replaceAll('_', ' ')})
        on conflict do nothing`;
      const [account] = await tx<{ id: string }[]>`
        select id from ledger_accounts where merchant_id is not distinct from ${line.merchantId} and code = ${line.accountCode} and currency = ${input.currency}`;
      if (!account) throw new Error(`Ledger account ${line.accountCode} was not resolved`);
      await tx`insert into ledger_entries (transaction_id, account_id, currency, debit, credit) values (${transactionId}, ${account.id}, ${input.currency}, ${line.debit ?? 0}, ${line.credit ?? 0})`;
    }
    await tx`update ledger_transactions set status = 'POSTED', posted_at = now() where id = ${transactionId}`;
    return transactionId;
  }

  async merchantBalance(tx: DbTransaction, merchantId: string, currency: string, code: 'MERCHANT_PENDING' | 'MERCHANT_AVAILABLE'): Promise<number> {
    const [row] = await tx<{ balance: string }[]>`
      select coalesce(sum(e.credit - e.debit), 0)::text as balance
      from ledger_accounts a join ledger_entries e on e.account_id = a.id join ledger_transactions t on t.id = e.transaction_id
      where a.merchant_id = ${merchantId} and a.currency = ${currency} and a.code = ${code} and t.status = 'POSTED'`;
    return Number(row?.balance ?? 0);
  }

  balances(merchantId: string): Promise<Array<{ currency: string; pending: string; available: string }>> {
    return this.database.sql<Array<{ currency: string; pending: string; available: string }>>`
      select a.currency,
        coalesce(sum(case when a.code = 'MERCHANT_PENDING' then e.credit - e.debit else 0 end), 0)::text as pending,
        coalesce(sum(case when a.code = 'MERCHANT_AVAILABLE' then e.credit - e.debit else 0 end), 0)::text as available
      from ledger_accounts a join ledger_entries e on e.account_id = a.id join ledger_transactions t on t.id = e.transaction_id
      where a.merchant_id = ${merchantId} and t.status = 'POSTED'
      group by a.currency order by a.currency`;
  }
}
