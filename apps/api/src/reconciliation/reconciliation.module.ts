import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PaymentProviderModule } from '../payment-provider/payment-provider.module';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

@Module({ imports: [AuditModule, PaymentProviderModule], controllers: [ReconciliationController], providers: [ReconciliationService], exports: [ReconciliationService] })
export class ReconciliationModule {}
