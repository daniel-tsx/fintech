import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from './domain-error';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    if (exception instanceof DomainError) {
      response.status(exception.httpStatus).json({ error: { code: exception.code, message: exception.message, details: exception.details }, correlationId: request.headers['x-correlation-id'] });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json({ error: { code: HttpStatus[status] ?? 'HTTP_ERROR', message: typeof body === 'string' ? body : exception.message, details: typeof body === 'object' ? body : undefined }, correlationId: request.headers['x-correlation-id'] });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }, correlationId: request.headers['x-correlation-id'] });
  }
}
