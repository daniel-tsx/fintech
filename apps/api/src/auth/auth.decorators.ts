import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { ActorRole, AuthActor } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const REQUIRED_ROLES = 'requiredRoles';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: ActorRole[]) => SetMetadata(REQUIRED_ROLES, roles);

export interface AuthenticatedRequest extends Request { actor: AuthActor }

export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext): AuthActor => {
  return context.switchToHttp().getRequest<AuthenticatedRequest>().actor;
});
