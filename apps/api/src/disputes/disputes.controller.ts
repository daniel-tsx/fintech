import { Controller, Get } from '@nestjs/common';
import { CurrentActor } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';

@Controller('disputes')
export class DisputesController {
  constructor(private readonly database: DatabaseService) {}
  @Get() list(@CurrentActor() actor: AuthActor) {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'A merchant context is required', 403);
    return this.database.sql`select id, payment_id as "paymentId", provider_dispute_id as "providerDisputeId", status, outcome, amount::text, currency, opened_at as "openedAt", closed_at as "closedAt" from disputes where merchant_id=${actor.merchantId} order by opened_at desc`;
  }
}
