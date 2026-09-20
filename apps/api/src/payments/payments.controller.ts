import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentActor } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { CapturePaymentDto, CreatePaymentDto, ProviderCommandDto } from './dto/create-payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiHeader({ name: 'x-api-key', required: true })
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  async create(@CurrentActor() actor: AuthActor, @Headers('idempotency-key') key: string, @Body() dto: CreatePaymentDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.payments.create(actor, key, dto);
    response.status(result.status).setHeader('idempotency-replayed', String(result.replayed));
    return result.value;
  }

  @Post(':id/authorize')
  async authorize(@CurrentActor() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key: string, @Body() dto: ProviderCommandDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.payments.authorize(actor, id, key, dto.scenario);
    response.status(result.status).setHeader('idempotency-replayed', String(result.replayed));
    return result.value;
  }

  @Post(':id/capture')
  async capture(@CurrentActor() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key: string, @Body() dto: CapturePaymentDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.payments.capture(actor, id, key, dto);
    response.status(result.status).setHeader('idempotency-replayed', String(result.replayed));
    return result.value;
  }

  @Post(':id/cancel')
  async cancel(@CurrentActor() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key: string, @Body() dto: ProviderCommandDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.payments.cancel(actor,id,key,dto.scenario); response.status(result.status).setHeader('idempotency-replayed',String(result.replayed)); return result.value;
  }

  @Get()
  list(@CurrentActor() actor: AuthActor, @Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.payments.list(actor, Math.max(1, Number(page)), Math.min(100, Math.max(1, Number(pageSize))));
  }

  @Get(':id')
  detail(@CurrentActor() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string) { return this.payments.detail(actor, id); }
}
