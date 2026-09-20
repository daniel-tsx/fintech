import { Controller, Get } from '@nestjs/common';
import { CurrentActor } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { DomainError } from '../common/domain-error';
import { LedgerService } from '../ledger/ledger.service';

@Controller('balances')
export class BalancesController {
  constructor(private readonly ledger: LedgerService) {}
  @Get() async list(@CurrentActor() actor: AuthActor) {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'A merchant context is required', 403);
    return { data: await this.ledger.balances(actor.merchantId) };
  }
}
