import { Body, Controller, ForbiddenException, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CurrentActor, Roles } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import type { ProviderScenario } from '../payment-provider/payment-provider.types';
import { PaymentsService } from '../payments/payments.service';

class InjectEventDto {
  @IsIn(['payment.authorized','payment.authorization_failed','payment.capture_succeeded','payment.capture_failed','refund.succeeded','refund.failed','dispute.opened','dispute.closed','settlement.completed']) type: string;
  @IsObject() data: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) @Max(300_000) delayMs = 0;
  @IsOptional() @IsBoolean() duplicate = false;
}

const SCENARIO_MAP: Record<string, ProviderScenario> = {
  success: 'SUCCESS', decline: 'DECLINE', timeout: 'TIMEOUT_BEFORE_PROCESSING', response_lost: 'PROCESSED_RESPONSE_LOST',
  delayed_webhook: 'DELAYED_WEBHOOK', duplicate_webhook: 'DUPLICATE_WEBHOOK', out_of_order: 'OUT_OF_ORDER_WEBHOOK', temporary_500: 'TEMPORARY_500', amount_mismatch: 'AMOUNT_MISMATCH',
};

@Controller('dev')
export class DevController {
  constructor(private readonly config: ConfigService, private readonly database: DatabaseService, private readonly outbox: OutboxService, private readonly payments: PaymentsService) {}

  @Post('scenarios/:scenario')
  @Roles('MERCHANT_ADMIN', 'PLATFORM_ADMIN')
  async scenario(@CurrentActor() actor: AuthActor, @Param('scenario') name: string) {
    this.assertDevelopment(); const scenario = SCENARIO_MAP[name];
    if (!scenario) return { supported: Object.keys(SCENARIO_MAP) };
    return (await this.payments.create(actor, `dev:${name}:${randomUUID()}`, { amount: 10_000, currency: 'USD', paymentMethodToken: 'pm_mock_visa', captureMethod: 'AUTOMATIC', confirm: true, scenario })).value;
  }

  @Post('mock-psp/events')
  @Roles('MERCHANT_ADMIN', 'PLATFORM_ADMIN')
  async event(@Body() dto: InjectEventDto) {
    this.assertDevelopment(); const eventId = `evt_manual_${randomUUID().replaceAll('-', '')}`;
    const aggregateId = typeof dto.data.paymentId === 'string' ? dto.data.paymentId : randomUUID();
    await this.database.transaction((tx) => this.outbox.add(tx, { aggregateType: 'MOCK_PSP', aggregateId, eventType: 'mock_psp.webhook', payload: { event: { id: eventId, type: dto.type, createdAt: new Date().toISOString(), data: dto.data }, duplicate: dto.duplicate }, availableAt: new Date(Date.now() + dto.delayMs) }));
    return { eventId, accepted: true };
  }

  @Post('reconciliation/unknown-transaction')
  @Roles('MERCHANT_ADMIN', 'PLATFORM_ADMIN')
  async unknown(@CurrentActor() actor: AuthActor) {
    this.assertDevelopment(); if (!actor.merchantId) throw new ForbiddenException();
    const id = `mpsp_unknown_${randomUUID().replaceAll('-', '')}`;
    await this.database.sql`insert into provider_transactions (merchant_id, provider_transaction_id, provider_idempotency_key, operation, status, amount, currency, raw_response) values (${actor.merchantId}, ${id}, ${`unknown:${id}`}, 'CAPTURE', 'CAPTURED', 4242, 'USD', '{"injected":true}')`;
    return { providerTransactionId: id };
  }

  private assertDevelopment(): void { if (this.config.get('NODE_ENV') === 'production') throw new ForbiddenException('Development scenarios are disabled'); }
}
