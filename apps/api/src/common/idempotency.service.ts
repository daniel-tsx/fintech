import { Injectable } from '@nestjs/common';
import { DomainError } from './domain-error';
import { requestHash } from './hash';
import { DatabaseService, DbTransaction } from '../database/database.service';

interface StoredIdempotency {
  request_hash: string;
  status: string;
  response_status: number | null;
  response_body: unknown;
}

export interface IdempotentResult<T> { value: T; status: number; replayed: boolean }

@Injectable()
export class IdempotencyService {
  constructor(private readonly database: DatabaseService) {}

  execute<T>(params: {
    merchantId: string; operation: string; key: string; payload: unknown; responseStatus: number;
    action: (tx: DbTransaction) => Promise<T>;
  }): Promise<IdempotentResult<T>> {
    if (!params.key || params.key.length > 255) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required', 400);
    const hash = requestHash(params.payload);
    return this.database.transaction(async (tx) => {
      const inserted = await tx<{ id: string }[]>`
        insert into idempotency_keys (merchant_id, operation, key, request_hash)
        values (${params.merchantId}, ${params.operation}, ${params.key}, ${hash})
        on conflict do nothing returning id`;
      if (inserted.length === 0) {
        const [stored] = await tx<StoredIdempotency[]>`
          select request_hash, status, response_status, response_body from idempotency_keys
          where merchant_id = ${params.merchantId} and operation = ${params.operation} and key = ${params.key}`;
        if (!stored) throw new DomainError('IDEMPOTENCY_STATE_LOST', 'Idempotency state could not be read', 500);
        if (stored.request_hash !== hash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This idempotency key was already used with a different request', 422);
        if (stored.status !== 'COMPLETED') throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 'An operation with this key is still in progress', 409);
        return { value: stored.response_body as T, status: stored.response_status ?? 200, replayed: true };
      }
      const value = await params.action(tx);
      await tx`update idempotency_keys set status = 'COMPLETED', response_status = ${params.responseStatus}, response_body = ${tx.json(value as never)}, updated_at = now() where merchant_id = ${params.merchantId} and operation = ${params.operation} and key = ${params.key}`;
      return { value, status: params.responseStatus, replayed: false };
    });
  }
}
