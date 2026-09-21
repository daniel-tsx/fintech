import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from './database/database.module';
import { PaymentCommandModule } from './payment-commands/payment-command.module';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), LoggerModule.forRoot(), DatabaseModule, PaymentCommandModule] })
export class PaymentCommandWorkerAppModule {}
