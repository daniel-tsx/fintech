import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const value = request.header('x-correlation-id')?.slice(0, 128) ?? randomUUID();
    request.headers['x-correlation-id'] = value;
    response.setHeader('x-correlation-id', value);
    next();
  }
}
