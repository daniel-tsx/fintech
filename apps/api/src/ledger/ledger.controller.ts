import { Controller, Get, Query } from '@nestjs/common';
import { CurrentActor } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';

@Controller('ledger')
export class LedgerController {
  constructor(private readonly database: DatabaseService) {}
  @Get('entries')
  list(@CurrentActor() actor: AuthActor, @Query('currency') currency?: string) {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'A merchant context is required', 403);
    return this.database.sql`select t.id as "transactionId", t.business_type as "businessType", t.business_id as "businessId", t.description, t.currency, t.posted_at as "postedAt", a.code as "accountCode", a.account_type as "accountType", e.debit::text, e.credit::text from ledger_transactions t join ledger_entries e on e.transaction_id=t.id join ledger_accounts a on a.id=e.account_id where t.merchant_id=${actor.merchantId} and (${currency ?? null}::text is null or t.currency=${currency ?? null}) order by t.created_at desc, e.created_at limit 500`;
  }
}
