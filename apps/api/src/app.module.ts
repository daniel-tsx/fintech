import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BalancesModule } from './balances/balances.module';
import { CommonModule } from './common/common.module';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { DatabaseModule } from './database/database.module';
import { DevModule } from './dev/dev.module';
import { DisputesModule } from './disputes/disputes.module';
import { LedgerModule } from './ledger/ledger.module';
import { ObservabilityModule } from './observability/observability.module';
import { PaymentProviderModule } from './payment-provider/payment-provider.module';
import { PaymentsModule } from './payments/payments.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { RefundsModule } from './refunds/refunds.module';
import { SettlementsModule } from './settlements/settlements.module';
import { WebhooksModule } from './webhooks/webhooks.module';

function validateConfig(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...input, NODE_ENV: input.NODE_ENV ?? 'development', PORT: input.PORT ?? '4000', DATABASE_URL: input.DATABASE_URL ?? 'postgres://fintech:fintech@localhost:5432/fintech_lab', REDIS_URL: input.REDIS_URL ?? 'redis://localhost:6379', WEBHOOK_SECRET: input.WEBHOOK_SECRET ?? 'local_webhook_secret_change_me' };
  for (const key of ['DATABASE_URL', 'REDIS_URL', 'WEBHOOK_SECRET']) if (!output[key]) throw new Error(`Missing required configuration: ${key}`);
  return output;
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateConfig }),
    LoggerModule.forRoot({ pinoHttp: { level: process.env.NODE_ENV === 'production' ? 'info' : 'debug', transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' }, redact: ['req.headers.x-api-key', 'req.headers.authorization', 'req.body.paymentMethodToken', 'req.body.destinationToken'] } }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule, CommonModule, AuthModule, AuditModule, BalancesModule, DevModule, DisputesModule, LedgerModule,
    ObservabilityModule, PaymentProviderModule, PaymentsModule, PayoutsModule, ReconciliationModule, RefundsModule, SettlementsModule, WebhooksModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void { consumer.apply(CorrelationMiddleware).forRoutes('*'); }
}
