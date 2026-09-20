import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import postgres, { Sql, TransactionSql } from 'postgres';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly sql: Sql;

  constructor(config: ConfigService) {
    this.sql = postgres(config.getOrThrow<string>('DATABASE_URL'), {
      max: Number(config.get('DB_POOL_SIZE', 10)),
      idle_timeout: 20,
      connect_timeout: 10,
      transform: { undefined: null },
    });
  }

  transaction<T>(work: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return this.sql.begin(work) as Promise<T>;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

export type DbTransaction = TransactionSql;
