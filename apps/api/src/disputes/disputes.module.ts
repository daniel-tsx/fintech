import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';

@Module({ imports: [AuditModule, LedgerModule], controllers: [DisputesController], providers: [DisputesService], exports: [DisputesService] })
export class DisputesModule {}
