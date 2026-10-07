import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from './database/database.module';
import { OutboxRelayModule } from './outbox/outbox-relay.module';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), LoggerModule.forRoot(), DatabaseModule, OutboxRelayModule] })
export class OutboxRelayAppModule {}
