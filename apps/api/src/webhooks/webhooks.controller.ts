import { Controller, Get, Headers, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentActor, Public } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';
import { WebhookReceiverService } from './webhook-receiver.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly receiver: WebhookReceiverService, private readonly database: DatabaseService) {}

  @Public()
  @Post('mock-psp')
  receive(@Req() request: RawBodyRequest<Request>, @Headers('x-mock-psp-signature') signature = '') {
    if (!request.rawBody) throw new DomainError('RAW_BODY_REQUIRED', 'Raw webhook body was not captured', 500);
    return this.receiver.receive(request.rawBody.toString('utf8'), signature, request.headers);
  }

  @Get()
  list(@CurrentActor() actor: AuthActor) {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'A merchant context is required', 403);
    return this.database.sql`select id, provider_event_id as "providerEventId", event_type as "eventType", status, attempts, last_error as "lastError", created_at as "createdAt", processed_at as "processedAt" from webhook_events where payload->'data'->>'merchantId'=${actor.merchantId} order by created_at desc limit 200`;
  }
}
