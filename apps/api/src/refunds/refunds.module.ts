import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

@Module({ imports: [AuditModule, LedgerModule, OutboxModule], controllers: [RefundsController], providers: [RefundsService], exports: [RefundsService] })
export class RefundsModule {}
