import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';

@Module({ imports: [AuditModule, LedgerModule], controllers: [SettlementsController], providers: [SettlementsService], exports: [SettlementsService] })
export class SettlementsModule {}
