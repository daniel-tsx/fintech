import { setTimeout as delay } from 'node:timers/promises';
import type { Sql } from 'postgres';
import { DomainError } from '../common/domain-error';
import type { DbTransaction } from '../database/database.service';

export const TRUSTED_RECEIPT_PUBLISHER = Symbol('TRUSTED_RECEIPT_PUBLISHER');
export const TRUSTED_RECEIPT_CORRELATOR = Symbol('TRUSTED_RECEIPT_CORRELATOR');
export const TRUSTED_RECEIPT_ENDPOINT = Symbol('TRUSTED_RECEIPT_ENDPOINT');
export interface TrustedReceiptEndpoint { account: string; webhookSecret: string }
export interface ReceiptTransactions {
  transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T>;
}

// No default connection or live module provider. The composition owns this
// dedicated restricted LOGIN pool and its shutdown; never use the owner pool.
export class RestrictedReceiptDatabase implements ReceiptTransactions {
  constructor(private readonly sql: Sql, private readonly capability: 'PUBLISHER' | 'CORRELATOR') {}

  async transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sql.begin('isolation level read committed', async tx => {
          const fn = this.capability === 'PUBLISHER'
            ? 'public.publish_verified_receipt_delivery(uuid,text,bytea,text,jsonb,jsonb,text)'
            : 'public.seal_financial_correlation(uuid,integer,uuid)';
          const [role] = await tx<{ safe: boolean }[]>`select
            current_user=session_user and rolcanlogin and not (rolsuper or rolinherit or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
            and not exists(select 1 from pg_catalog.pg_auth_members where member=r.oid)
            and pg_catalog.has_function_privilege(current_user,${fn},'EXECUTE')
            and not exists(select 1 from pg_catalog.unnest(array['public.ledger_transactions','public.ledger_entries','public.ledger_accounts',
              'public.provider_financial_receipts','public.webhook_financial_evidence','public.provider_financial_observations',
              'public.receipt_delivery_attempts','public.receipt_delivery_barriers']) t(name)
              where pg_catalog.has_table_privilege(current_user,t.name,'INSERT,UPDATE,DELETE,TRUNCATE')) as safe
            from pg_catalog.pg_roles r where rolname=current_user`;
          if (!role?.safe) throw new DomainError('RECEIPT_CAPABILITY_REQUIRED', 'A dedicated restricted receipt database login is required', 500);
          return work(tx);
        }) as T;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!['40001', '40P01'].includes(code ?? '') || attempt >= 2) throw error;
        // begin() has rolled back before this bounded whole-transaction retry.
        await delay(10 * (attempt + 1));
      }
    }
  }
}
