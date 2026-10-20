import { randomBytes, randomUUID } from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { captureFixture } from '../support/accounting-fixtures';
import { trustedReceiptHarness } from '../support/trusted-receipt-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

// Reviewer-owned negative regressions. These intentionally remain red until the
// implementation closes the ownership escape; no financial guard is replaced.
describeDb('R2-A independent reverse-ownership guard review', () => {
  let h: Awaited<ReturnType<typeof trustedReceiptHarness>>, writer: Sql;
  beforeAll(async () => {
    h = await trustedReceiptHarness();
    const role = `r2a_review_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
    await h.db.sql.unsafe(`create role "${role}" login password '${password}' noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await h.db.sql.unsafe(`grant usage on schema public to "${role}"`);
    await h.db.sql.unsafe(`grant select on public.ledger_transactions,public.ledger_entries,public.ledger_accounts,public.settlement_items to "${role}"`);
    await h.db.sql.unsafe(`grant insert,update on public.ledger_transactions to "${role}"`);
    await h.db.sql.unsafe(`grant insert on public.ledger_entries to "${role}"`);
    await h.db.sql.unsafe(`grant insert,update on public.settlement_items to "${role}"`);
    const url = new URL(process.env.MIGRATION_ADMIN_URL!);
    url.pathname = '/' + String((await h.db.sql`select current_database() n`)[0].n); url.username = role; url.password = password;
    writer = postgres(url.toString(), { max: 1, connection: { statement_timeout: 10000 } });
    expect((await h.db.sql`select count(*)::int n from pg_auth_members where member=(select oid from pg_roles where rolname=${role})`)[0].n).toBe(0);
    expect((await h.db.sql`select has_table_privilege(${role},'public.financial_application_permits','INSERT,UPDATE,DELETE') w`)[0].w).toBe(false);
  }, 30000);
  afterAll(async () => { if (writer) await writer.end(); if (h) await h.close(); });

  async function fixture() {
    const a = await captureFixture(h.db), b = await captureFixture(h.db), attemptId = randomUUID(), batchId = randomUUID();
    const account = `acct_review_${randomUUID().replaceAll('-', '')}`;
    await h.db.sql`insert into payment_attempts(id,merchant_id,payment_id,kind,status,amount,currency)
      values(${attemptId},${a.merchantId},${a.paymentId},'CAPTURE','PENDING',1000,'USD')`;
    await h.db.sql`insert into settlements(id,merchant_id,currency,gross_amount,fee_amount,net_amount,available_on)
      values(${batchId},${a.merchantId},'USD',10000,300,9700,now())`;
    await h.db.sql`insert into capture_accounting_scopes(merchant_id,currency) values(${a.merchantId},'USD')`;
    await h.db.sql`insert into financial_evidence_accounts(provider,provider_account) values('STRIPE',${account})`;
    for (const currency of ['USD', 'EUR']) for (const code of ['PLATFORM_CASH', 'PSP_CLEARING']) {
      await h.db.sql`insert into ledger_accounts(merchant_id,code,account_type,currency,name)
        values(null,${code},'ASSET',${currency},'Independent SQL review fixture') on conflict do nothing`;
    }
    return { a, b, attemptId, batchId, account };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function enroll(f: Fixture) {
    await h.db.sql`insert into financial_application_scope_authority(merchant_id,currency,provider,provider_account,policy,epoch,admission_mode)
      values(${f.a.merchantId},'USD','STRIPE',${f.account},'CAPTURE_FIFO_V1',1,'DORMANT')`;
  }
  async function outcome(action: () => Promise<unknown>) {
    try { await action(); return '00000'; } catch (error: unknown) { return (error as { code: string }).code; }
  }
  async function post(tx: TransactionSql, id: string, operation: string, merchant: string, currency: string) {
    await tx`insert into ledger_transactions(id,merchant_id,business_type,business_id,currency,description)
      values(${id},${merchant},'CAPTURE',${operation},${currency},'Independent unsupported-operation probe')`;
    await tx`insert into ledger_entries(transaction_id,account_id,currency,debit,credit)
      select ${id},id,${currency},case when code='PLATFORM_CASH' then 1000 else 0 end,
        case when code='PSP_CLEARING' then 1000 else 0 end from ledger_accounts
        where merchant_id is null and currency=${currency} and code in ('PLATFORM_CASH','PSP_CLEARING')`;
    await tx`update ledger_transactions set status='POSTED',posted_at=now() where id=${id}`;
  }
  it.each(['merchant', 'currency'] as const)('missing canonical root cannot conceal a protected CAPTURE behind a different %s', async field => {
    const f = await fixture(); await enroll(f); const id = randomUUID();
    const sqlstate = await outcome(() => writer.begin(tx => post(tx, id, f.attemptId,
      field === 'merchant' ? f.b.merchantId : f.a.merchantId, field === 'currency' ? 'EUR' : 'USD')));
    const journals = await h.db.sql`select status,merchant_id,currency from ledger_transactions where id=${id}`;
    const applications = await h.db.sql`select 1 from financial_applications`;
    expect({ sqlstate, journals: journals.length, applications: applications.length }).toEqual({ sqlstate: 'P0001', journals: 0, applications: 0 });
  });
  it('a protected settlement header cannot receive an unowned legacy-shaped candidate without a permit', async () => {
    const f = await fixture(); await enroll(f); const id = randomUUID();
    const sqlstate = await outcome(() => writer`insert into settlement_items(id,settlement_id,payment_id,capture_attempt_id,gross_amount,fee_amount,net_amount,currency)
      values(${id},${f.batchId},${f.b.paymentId},${f.a.attemptId},10000,300,9700,'USD')`);
    const items = await h.db.sql`select 1 from settlement_items where id=${id}`;
    expect({ sqlstate, items: items.length }).toEqual({ sqlstate: 'P0001', items: 0 });
  });
  it('retargeting the payment cannot remove an existing protected settlement candidate from the guard', async () => {
    const f = await fixture(), id = randomUUID();
    await h.db.sql`insert into settlement_items(id,settlement_id,payment_id,capture_attempt_id,gross_amount,fee_amount,net_amount,currency)
      values(${id},${f.batchId},${f.a.paymentId},${f.a.attemptId},10000,300,9700,'USD')`;
    await enroll(f);
    const sqlstate = await outcome(() => writer`update settlement_items set payment_id=${f.b.paymentId},gross_amount=9999 where id=${id}`);
    const [item] = await h.db.sql`select payment_id,gross_amount::text from settlement_items where id=${id}`;
    expect({ sqlstate, ...item }).toEqual({ sqlstate: 'P0001', payment_id: f.a.paymentId, gross_amount: '10000' });
  });
  it('ordinary writes using the actual protected scope remain closed', async () => {
    const f = await fixture(); await enroll(f); const id = randomUUID();
    expect(await outcome(() => writer.begin(tx => post(tx, id, f.attemptId, f.a.merchantId, 'USD')))).toBe('P0001');
    expect(await h.db.sql`select 1 from ledger_transactions where id=${id}`).toHaveLength(0);
    expect((await h.db.sql`select count(*)::int n from capture_accounting_scopes where status='ACTIVE'`)[0].n).toBe(0);
  });
});
