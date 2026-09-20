import { Controller, Get } from '@nestjs/common';
import { CurrentActor } from '../auth/auth.decorators';
import type { AuthActor } from '../auth/auth.types';
import { DomainError } from '../common/domain-error';
import { DatabaseService } from '../database/database.service';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly database: DatabaseService) {}
  @Get() list(@CurrentActor() actor: AuthActor) {
    if (!actor.merchantId) throw new DomainError('MERCHANT_CONTEXT_REQUIRED', 'A merchant context is required', 403);
    return this.database.sql`select id, actor_type as "actorType", actor_id as "actorId", action, target_type as "targetType", target_id as "targetId", correlation_id as "correlationId", metadata, created_at as "createdAt" from audit_logs where merchant_id=${actor.merchantId} order by created_at desc limit 300`;
  }
}
