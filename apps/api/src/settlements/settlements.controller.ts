import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentActor } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { SettlementsService } from './settlements.service';

@Controller('settlements')
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}
  @Get() list(@CurrentActor() actor: AuthActor) { return this.settlements.list(actor); }
  @Post('generate') async generate(@CurrentActor() actor: AuthActor) { return { settlementIds: await this.settlements.generate(actor.merchantId ?? undefined) }; }
  @Post(':id/complete') async complete(@CurrentActor() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string) {
    if (!actor.merchantId) return { id, completed: false };
    await this.settlements.completeForMerchant(id, actor.merchantId); return { id, completed: true };
  }
}
