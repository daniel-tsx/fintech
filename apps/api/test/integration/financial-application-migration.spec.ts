import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { providerObservationHarness } from '../support/provider-observation-harness';
import { publishCommandObservation, signedEvidence } from '../support/trusted-evidence-fixtures';

const describeDb = process.env.RUN_DB_TESTS === '1' && process.env.RUN_MIGRATION_TESTS === '1' ? describe : describe.skip;
describeDb('R2-A additive migration compatibility', () => {
  const folder = resolve(__dirname, '../../drizzle'), harnesses: Awaited<ReturnType<typeof providerObservationHarness>>[] = [];
  function staged(failure = false, count = 10) {
    const target = resolve(__dirname, `../../../../.tmp/r2a-migrations-${randomUUID()}`);
    mkdirSync(resolve(target, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(resolve(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter(e => e.idx < (failure ? 11 : count));
    writeFileSync(resolve(target, 'meta/_journal.json'), JSON.stringify(journal));
    for (const e of journal.entries) copyFileSync(resolve(folder, e.tag + '.sql'), resolve(target, e.tag + '.sql'));
    if (failure) {
      const file = resolve(target, '0010_financial_application_foundation.sql');
      writeFileSync(file, readFileSync(file, 'utf8') + "\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'planned R2-A rollback'; END $$;\n");
    }
    return target;
  }
  async function setup(source = staged(false,12)) {
    const h = await providerObservationHarness(source); harnesses.push(h);
    const url = new URL(process.env.MIGRATION_ADMIN_URL!); url.pathname = '/' + String((await h.db.sql`select current_database() n`)[0].n);
    async function apply(from = staged(false,12)) { const sql = postgres(url.toString(), { max: 1 }); try { await migrate(drizzle(sql), { migrationsFolder: from }); } finally { await sql.end(); } }
    return { h, url, apply };
  }
  afterAll(async () => { for (const h of harnesses) await h.close(12); });
  async function fingerprint(sql: Sql) {
    const tables = ['ledger_transactions','ledger_entries','capture_accounting_lots','refund_capture_allocations','provider_financial_observations',
      'provider_financial_receipts','webhook_financial_evidence','provider_command_authorities','provider_command_executions','provider_observation_sources','provider_observation_obligations'];
    const result: Record<string, unknown> = {};
    for (const table of tables) result[table] = (await sql.unsafe(`select md5(coalesce(string_agg(j,'|' order by j),'')) hash from (select to_jsonb(t)::text j from public.${table} t) s`))[0].hash;
    return result;
  }
  it('fresh repeatable twelve-migration install leaves every contract and enrollment closed', async () => {
    const { h, apply } = await setup(); await apply();
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(12);
    for (const table of ['financial_application_contracts','financial_application_scope_authority','financial_application_roots','financial_application_manifests','financial_application_permits','financial_applications','financial_application_dispositions','financial_application_effect_links','financial_application_revision_effects'])
      expect(await h.db.sql.unsafe(`select 1 from public.${table}`)).toHaveLength(0);
    const functions = await h.db.sql`select p.proname,p.proconfig from pg_proc p where p.pronamespace='public'::regnamespace
      and p.proowner in (select oid from pg_roles where rolname='fintech_application_'||md5(current_database()))`;
    expect(functions).toHaveLength(13); for (const f of functions) expect(f.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
  }, 30000);
  it('legacy payment INSERT remains legal with no enrollment or application permit (original 42702 regression)', async () => {
    const { h } = await setup(), merchantId = randomUUID(), paymentId = randomUUID();
    await h.db.sql`insert into merchants(id,name,fee_bps,settlement_delay_days) values(${merchantId},'R2-A.1 original SQL regression',300,0)`;
    // Exact captureFixture statement that failed inside the BEFORE trigger even
    // though the private scope-authority registry was empty. No permit is issued.
    await h.db.sql`insert into payments(id,merchant_id,status,capture_method,currency,amount,authorized_amount,captured_amount,platform_fee_amount,payment_method_token)
      values(${paymentId},${merchantId},'CAPTURED','MANUAL','USD',10000,10000,10000,300,'pm_test')`;
    expect((await h.db.sql`select status,captured_amount::text from payments where id=${paymentId}`)[0]).toEqual({ status: 'CAPTURED', captured_amount: '10000' });
    expect(await h.db.sql`select 1 from financial_application_scope_authority`).toHaveLength(0);
    expect(await h.db.sql`select 1 from financial_application_permits`).toHaveLength(0);
  }, 30000);
  it('populated 0009 upgrade preserves complete journals, original receipts/proofs and genuine D02 bytes', async () => {
    const { h, apply } = await setup(staged()), f = await h.accepted();
    await h.db.transaction(tx => publishCommandObservation(tx, f, 'CAPTURE'));
    await (await f.producer.execute(f.message)).publish();
    const signed = signedEvidence({ ...f, refundId: f.operationId, objectId: f.object.id }, { object: { amount: 2000 } }), attested = h.sign(signed.raw);
    const receipt = await h.receiver(f.account).receive(attested.raw, attested.signature, {});
    // Preserve the independent failed-fixture diagnosis: acceptance alone does
    // not create the exact frozen attribution required by the existing0006 proof.
    await expect(h.db.sql`select public.build_financial_evidence(${receipt.id},
      (select observation_id from provider_observation_projections l join provider_observation_sources s on s.id=l.source_id where s.outbox_id=${f.outboxId}))`).rejects.toThrow(/Trustworthy frozen refund attribution required/);
    await h.db.sql`insert into refund_capture_allocations(refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross)
      values(${f.operationId},${f.lotId},${f.paymentId},${f.merchantId},'USD',2000)`;
    expect(await h.correlate(f.account).correlate(receipt.id)).toMatchObject({ state: 'BOUND' });
    const before = await fingerprint(h.db.sql); await apply(); await apply(); expect(await fingerprint(h.db.sql)).toEqual(before);
    expect(await h.db.sql`select * from financial_application_scope_authority`).toHaveLength(0);
    await expect(h.db.sql`select public.assert_financial_evidence_runtime_ready()`).rejects.toThrow(/UNINSTALLED/);
    await expect(h.db.sql`update ledger_entries set debit=debit where transaction_id=${f.journalId}`).rejects.toThrow(/immutable/);
  }, 30000);
  it('late migration failure rolls back all new relations, ownership keys, triggers and owner', async () => {
    const { h, apply } = await setup(staged()), f = await h.accepted(); await (await f.producer.execute(f.message)).publish();
    const before = await fingerprint(h.db.sql); let error: unknown;
    try { await apply(staged(true)); } catch (e: unknown) { error = e; }
    expect((error as { cause: Error }).cause.message).toMatch(/planned R2-A rollback/);
    expect(await fingerprint(h.db.sql)).toEqual(before);
    expect((await h.db.sql`select to_regclass('public.financial_applications') r,exists(select 1 from pg_roles where rolname='fintech_application_'||md5(current_database())) owner,
      exists(select 1 from pg_constraint where conname='application_refund_allocation_scope') added_key`)[0]).toEqual({ r: null, owner: false, added_key: false });
    await apply();
  }, 30000);
  it('forward DDL waits on a real legacy writer then installs transactionally', async () => {
    const { h, url, apply } = await setup(staged()); let release!: () => void, ready!: () => void, holder = 0;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { ready = r; });
    const first = h.db.transaction(async tx => { holder = Number((await tx`select pg_backend_pid() p`)[0].p); await tx`lock table public.refund_capture_allocations in row exclusive mode`; ready(); await gate; });
    const sql = postgres(url.toString(), { max: 1 }); let pending: Promise<void> | undefined;
    try {
      await Promise.race([started, first]); const waiter = Number((await sql`select pg_backend_pid() p`)[0].p); expect(waiter).not.toBe(holder);
      pending = migrate(drizzle(sql), { migrationsFolder: staged(false,12) }); let observed = false;
      for (let n = 0; n < 150; n++) { if ((await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) b`)[0].b) { observed = true; break; } await delay(20); }
      expect(observed).toBe(true); expect((await h.db.sql`select to_regclass('public.financial_applications') r`)[0].r).toBeNull();
      release(); await Promise.all([first, pending]); await apply();
    } finally { release(); await Promise.allSettled([first, ...(pending ? [pending] : [])]); await sql.end(); }
  }, 30000);
});
