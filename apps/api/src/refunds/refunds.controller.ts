import { Body, Controller, Headers, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentActor } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { CreateRefundDto } from './refunds.dto';
import { RefundsService } from './refunds.service';

@Controller('payments/:paymentId/refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}
  @Post()
  async create(@CurrentActor() actor: AuthActor, @Param('paymentId', ParseUUIDPipe) paymentId: string, @Headers('idempotency-key') key: string, @Body() dto: CreateRefundDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.refunds.create(actor, paymentId, key, dto);
    response.status(result.status).setHeader('idempotency-replayed', String(result.replayed));
    return result.value;
  }
}
