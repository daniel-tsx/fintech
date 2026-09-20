import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import { sha256 } from '../common/hash';
import { AuthenticatedRequest, IS_PUBLIC, REQUIRED_ROLES } from './auth.decorators';
import type { ActorRole, AuthActor } from './auth.types';

interface ApiKeyRow { id: string; merchant_id: string; role: ActorRole }
interface UserRow { id: string; merchant_id: string | null; role: ActorRole }

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly database: DatabaseService, private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = await this.authenticate(request);
    const roles = this.reflector.getAllAndOverride<ActorRole[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]);
    if (roles && !roles.includes(actor.role)) throw new ForbiddenException('This actor does not have the required role');
    request.actor = { ...actor, correlationId: String(request.headers['x-correlation-id'] ?? '') };
    return true;
  }

  private async authenticate(request: Request): Promise<AuthActor> {
    const apiKey = request.header('x-api-key');
    if (apiKey) {
      const [row] = await this.database.sql<ApiKeyRow[]>`
        update api_keys set last_used_at = now() where key_hash = ${sha256(apiKey)} and revoked_at is null
        returning id, merchant_id, role`;
      if (!row) throw new UnauthorizedException('Invalid API key');
      return { id: row.id, type: 'API_KEY', merchantId: row.merchant_id, role: row.role };
    }
    const demoUserId = request.header('x-demo-user-id');
    if (this.config.get('NODE_ENV') !== 'production' && demoUserId) {
      const [row] = await this.database.sql<UserRow[]>`select id, merchant_id, role from users where id = ${demoUserId}`;
      if (row) return { id: row.id, type: 'USER', merchantId: row.merchant_id, role: row.role };
    }
    throw new UnauthorizedException('Provide x-api-key or a development user identity');
  }
}
