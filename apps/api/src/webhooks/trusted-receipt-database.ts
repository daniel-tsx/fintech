import { setTimeout as delay } from 'node:timers/promises';
import type { Sql } from 'postgres';
import { DomainError } from '../common/domain-error';
import type { DbTransaction } from '../database/database.service';

export const TRUSTED_RECEIPT_PUBLISHER = Symbol('TRUSTED_RECEIPT_PUBLISHER');
export const TRUSTED_RECEIPT_CORRELATOR = Symbol('TRUSTED_RECEIPT_CORRELATOR');
export const TRUSTED_RECEIPT_ENDPOINT = Symbol('TRUSTED_RECEIPT_ENDPOINT');
export interface TrustedReceiptEndpoint { account: string; webhookSecret: string; admissionContract?: 'PAYMENT_OPERATION_V2' }
export interface ReceiptTransactions {
  transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T>;
}

// No default connection or live module provider. The composition owns this
// dedicated restricted LOGIN pool and its shutdown; never use the owner pool.
export class RestrictedReceiptDatabase implements ReceiptTransactions {
  constructor(private readonly sql: Sql, private readonly capability: 'PUBLISHER' | 'CORRELATOR' | 'PAYMENT_PUBLISHER' | 'PAYMENT_CORRELATOR') {}

  async transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sql.begin('isolation level read committed', async tx => {
          const fn = this.capability === 'PAYMENT_PUBLISHER' ? 'public.publish_admitted_payment_receipt(uuid,text,bytea,text)'
            : this.capability === 'PAYMENT_CORRELATOR' ? 'public.seal_payment_operation_evidence(uuid,integer,bigint,uuid,uuid)'
            : this.capability === 'PUBLISHER'
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
          if (this.capability.startsWith('PAYMENT_')) {
            const [proof] = await tx<{ unsafe: boolean }[]>`select exists(select 1 from pg_catalog.unnest(array[
              'public.payment_operation_evidence','public.receipt_admission_obligations','public.provider_command_authorities',
              'public.provider_command_executions','public.provider_observation_sources','public.provider_observation_obligations',
              'public.financial_application_contracts','public.financial_application_permits','public.financial_applications',
              'public.financial_application_dispositions','public.ledger_transactions','public.ledger_entries','public.ledger_accounts']) t(name)
              where pg_catalog.has_table_privilege(current_user,t.name,'INSERT,UPDATE,DELETE,TRUNCATE')
                or pg_catalog.has_any_column_privilege(current_user,t.name,'INSERT,UPDATE')) as unsafe`;
            if (proof.unsafe) throw new DomainError('RECEIPT_CAPABILITY_REQUIRED', 'Payment evidence requires restricted function capabilities', 500);
          }
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
