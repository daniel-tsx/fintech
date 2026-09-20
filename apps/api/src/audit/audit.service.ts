import { Injectable } from '@nestjs/common';
import type { DbTransaction } from '../database/database.service';

export interface AuditActor { type: 'API_KEY' | 'USER' | 'SYSTEM' | 'PROVIDER'; id?: string; correlationId?: string }

@Injectable()
export class AuditService {
  async append(tx: DbTransaction, event: { merchantId?: string | null; actor: AuditActor; action: string; targetType: string; targetId: string; metadata?: Record<string, unknown> }): Promise<void> {
    await tx`insert into audit_logs (merchant_id, actor_type, actor_id, action, target_type, target_id, correlation_id, metadata)
      values (${event.merchantId ?? null}, ${event.actor.type}, ${event.actor.id ?? null}, ${event.action}, ${event.targetType}, ${event.targetId}, ${event.actor.correlationId ?? null}, ${tx.json((event.metadata ?? {}) as never)})`;
  }
}
