import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { BalancesController } from './balances.controller';

@Module({ imports: [LedgerModule], controllers: [BalancesController] })
export class BalancesModule {}
