import { Body, Controller, Get, Headers, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentActor } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { CreatePayoutDto } from './payouts.dto';
import { PayoutsService } from './payouts.service';

@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}
  @Post() async request(@CurrentActor() actor: AuthActor, @Headers('idempotency-key') key: string, @Body() dto: CreatePayoutDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.payouts.request(actor, key, dto); response.status(result.status).setHeader('idempotency-replayed', String(result.replayed)); return result.value;
  }
  @Get() list(@CurrentActor() actor: AuthActor) { return this.payouts.list(actor); }
}
