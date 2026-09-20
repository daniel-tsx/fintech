import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

@Module({ imports: [AuditModule, LedgerModule, OutboxModule], controllers: [PayoutsController], providers: [PayoutsService], exports: [PayoutsService] })
export class PayoutsModule {}
