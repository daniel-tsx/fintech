import type { Sql } from 'postgres';
import type { DbTransaction } from '../database/database.service';

export interface ObservationTransactions { transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> }

// Explicit isolated composition only: no owner connection, default credentials,
// Nest module registration, or retries around the remote monetary operation.
export class RestrictedObservationDatabase implements ObservationTransactions {
  constructor(private readonly sql: Sql) {}
  async transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.sql.begin('isolation level read committed', async tx => {
      const [role] = await tx<{ safe: boolean }[]>`select current_user=session_user and rolcanlogin
        and not (rolsuper or rolinherit or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
        and not exists(select 1 from pg_catalog.pg_auth_members where member=r.oid)
        and not pg_catalog.has_schema_privilege(current_user,'public','CREATE')
        and pg_catalog.has_function_privilege(current_user,'public.prepare_provider_execution(uuid,uuid,text,text,jsonb,text,uuid)','EXECUTE')
        and pg_catalog.has_function_privilege(current_user,'public.publish_provider_observation(uuid,text,text,text,text,uuid,text,uuid,text,uuid,jsonb,bytea,text,text,timestamptz)','EXECUTE')
        and not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind in ('r','p') and
          (pg_catalog.has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
            or pg_catalog.has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')))
        as safe from pg_catalog.pg_roles r where rolname=current_user`;
      if (!role?.safe) throw new Error('Dedicated restricted D02 publisher LOGIN required');
      return work(tx);
    }) as Promise<T>;
  }
}
