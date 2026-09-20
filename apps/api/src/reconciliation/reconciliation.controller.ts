import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentActor, Roles } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { ReconciliationService } from './reconciliation.service';

class ResolveIssueDto { @IsString() @MinLength(3) @MaxLength(1000) note: string }

@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}
  @Get('issues') list(@CurrentActor() actor: AuthActor) { return this.reconciliation.list(actor); }
  @Post('runs') @Roles('PLATFORM_ADMIN', 'MERCHANT_ADMIN') run() { return this.reconciliation.run(); }
  @Post('issues/:id/resolve') @Roles('PLATFORM_ADMIN', 'MERCHANT_ADMIN') async resolve(@CurrentActor() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveIssueDto) { await this.reconciliation.resolve(actor, id, dto.note); return { id, status: 'RESOLVED' }; }
}
