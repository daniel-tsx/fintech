import { randomBytes, randomUUID } from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { captureFixture } from '../support/accounting-fixtures';
import { trustedReceiptHarness } from '../support/trusted-receipt-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeDb('R2-A.2 authoritative financial ownership', () => {
  let h: Awaited<ReturnType<typeof trustedReceiptHarness>>, writer: Sql;
  beforeAll(async () => {
    h = await trustedReceiptHarness();
    const role = `r2a2_writer_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
    await h.db.sql.unsafe(`create role "${role}" login password '${password}' noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await h.db.sql.unsafe(`grant usage on schema public to "${role}"`);
    await h.db.sql.unsafe(`grant select,insert,update on public.ledger_transactions,public.ledger_entries,public.settlement_items to "${role}"`);
    await h.db.sql.unsafe(`grant select on public.ledger_accounts to "${role}"`);
    const url = new URL(process.env.MIGRATION_ADMIN_URL!);
    url.pathname = '/' + String((await h.db.sql`select current_database() n`)[0].n); url.username = role; url.password = password;
    writer = postgres(url.toString(), { max: 1, connection: { statement_timeout: 10000 } });
    expect((await h.db.sql`select has_table_privilege(${role},'financial_application_permits','INSERT,UPDATE,DELETE') w`)[0].w).toBe(false);
    expect((await h.db.sql`select count(*)::int n from pg_auth_members where member=(select oid from pg_roles where rolname=${role})`)[0].n).toBe(0);
  }, 30000);
  afterAll(async () => { if (writer) await writer.end(); if (h) await h.close(); });

  async function fixture() {
    const a = await captureFixture(h.db), b = await captureFixture(h.db), pending = randomUUID(), batch = randomUUID();
    const refund = randomUUID(), dispute = randomUUID(), payout = randomUUID(), account = `acct_r2a2_${randomUUID()}`;
    await h.db.sql`insert into payment_attempts(id,merchant_id,payment_id,kind,amount,currency)
      values(${pending},${a.merchantId},${a.paymentId},'CAPTURE',1000,'USD')`;
    await h.db.sql`insert into refunds(id,merchant_id,payment_id,amount,currency) values(${refund},${a.merchantId},${a.paymentId},1000,'USD')`;
    await h.db.sql`insert into disputes(id,merchant_id,payment_id,provider_dispute_id,status,amount,currency,opened_at)
      values(${dispute},${a.merchantId},${a.paymentId},${`dp_${dispute}`},'OPEN',1000,'USD',now())`;
    await h.db.sql`insert into payouts(id,merchant_id,amount,currency,destination_token) values(${payout},${a.merchantId},1000,'USD','bank_fixture')`;
    await h.db.sql`insert into settlements(id,merchant_id,currency,gross_amount,fee_amount,net_amount,available_on)
      values(${batch},${a.merchantId},'USD',10000,300,9700,now())`;
    await h.db.sql`insert into capture_accounting_scopes(merchant_id,currency) values(${a.merchantId},'USD')`;
    await h.db.sql`insert into financial_evidence_accounts(provider,provider_account) values('STRIPE',${account})`;
    return { a, b, pending, batch, refund, dispute, payout, account };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function enroll(tx: TransactionSql | Sql, f: Fixture) {
    await tx`insert into financial_application_scope_authority(merchant_id,currency,provider,provider_account,policy,epoch,admission_mode)
      values(${f.a.merchantId},'USD','STRIPE',${f.account},'CAPTURE_FIFO_V1',1,'DORMANT')`;
  }
  async function draft(tx: TransactionSql | Sql, id: string, business: string, operation: string, merchant: string, currency = 'USD') {
    await tx`insert into ledger_transactions(id,merchant_id,business_type,business_id,currency,description)
      values(${id},${merchant},${business},${operation},${currency},'R2-A.2 ownership regression')`;
  }
  async function item(tx: TransactionSql | Sql, f: Fixture, id: string, override: Record<string, string | number> = {}) {
    const row = { batch: f.batch, payment: f.a.paymentId, attempt: f.a.attemptId, currency: 'USD', gross: 10000, fee: 300, net: 9700, ...override };
    await tx`insert into settlement_items(id,settlement_id,payment_id,capture_attempt_id,currency,gross_amount,fee_amount,net_amount)
      values(${id},${row.batch},${row.payment},${row.attempt},${row.currency},${row.gross},${row.fee},${row.net})`;
  }
  async function unchanged(table: string, id: string, action: () => Promise<unknown>, expected: RegExp) {
    const before = await h.db.sql.unsafe(`select to_jsonb(t) row from public.${table} t where id=$1`, [id]);
    await expect(action()).rejects.toThrow(expected);
    expect(await h.db.sql.unsafe(`select to_jsonb(t) row from public.${table} t where id=$1`, [id])).toEqual(before);
  }
  it.each(['CAPTURE', 'REFUND', 'DISPUTE_OPEN', 'DISPUTE_CLOSE', 'SETTLEMENT', 'PAYOUT_RESERVATION', 'PAYOUT_COMPLETION', 'UNSUPPORTED'] as const)
  ('%s cannot hide an owned operation behind another merchant without a root', async business => {
    const f = await fixture(); await enroll(h.db.sql, f); const id = randomUUID();
    const operation = business === 'REFUND' ? f.refund : business.startsWith('DISPUTE') ? f.dispute
      : business === 'SETTLEMENT' ? f.batch : business.startsWith('PAYOUT') ? f.payout : f.pending;
    await expect(draft(writer, id, business, operation, f.b.merchantId)).rejects.toThrow(/Current transaction\/backend/);
    expect(await h.db.sql`select 1 from ledger_transactions where id=${id}`).toHaveLength(0);
    expect(await h.db.sql`select 1 from financial_applications`).toHaveLength(0);
  });
  it.each(['merchant_id', 'currency', 'business_id'] as const)('OLD journal ownership survives changing %s', async field => {
    const f = await fixture(), id = randomUUID(); await draft(writer, id, 'CAPTURE', f.pending, f.a.merchantId); await enroll(h.db.sql, f);
    const value = field === 'merchant_id' ? f.b.merchantId : field === 'currency' ? 'EUR' : f.b.attemptId;
    await unchanged('ledger_transactions', id, () => writer.unsafe(`update ledger_transactions set ${field}=$1 where id=$2`, [value, id]), /Current transaction\/backend/);
  });
  it('an entry cannot hide a protected operation through an unowned parent and platform account', async () => {
    const f = await fixture(), id = randomUUID(); await draft(writer, id, 'CAPTURE', f.pending, f.b.merchantId); await enroll(h.db.sql, f);
    const account = String((await h.db.sql`select id from ledger_accounts where merchant_id is null and code='PSP_CLEARING' and currency='USD'`)[0].id);
    await expect(writer`insert into ledger_entries(transaction_id,account_id,currency,debit,credit) values(${id},${account},'USD',1000,0)`).rejects.toThrow(/Current transaction\/backend/);
    expect(await h.db.sql`select 1 from ledger_entries where transaction_id=${id}`).toHaveLength(0);
  });
  it.each(['settlement_id', 'payment_id', 'capture_attempt_id', 'currency', 'gross_amount'] as const)
  ('OLD settlement ownership survives changing %s', async field => {
    const f = await fixture(), id = randomUUID(), other = randomUUID(); await item(writer, f, id);
    await h.db.sql`insert into settlements(id,merchant_id,currency,available_on) values(${other},${f.b.merchantId},'USD',now())`;
    await enroll(h.db.sql, f);
    const value = field === 'settlement_id' ? other : field === 'payment_id' ? f.b.paymentId
      : field === 'capture_attempt_id' ? f.b.attemptId : field === 'currency' ? 'EUR' : 9999;
    await unchanged('settlement_items', id, () => writer.unsafe(`update settlement_items set ${field}=$1 where id=$2`, [value, id]), /Current transaction\/backend/);
  });
  it.each(['header', 'capture', 'payment'] as const)('the %s owner independently protects mismatched candidates', async owner => {
    const f = await fixture(), id = randomUUID(); await enroll(h.db.sql, f);
    const overrides: Record<string, string | number> = owner === 'header' ? { payment: f.b.paymentId, attempt: f.b.attemptId }
      : owner === 'capture' ? { payment: f.b.paymentId } : { attempt: f.b.attemptId };
    if (owner !== 'header') {
      const other = randomUUID(); await h.db.sql`insert into settlements(id,merchant_id,currency,available_on) values(${other},${f.b.merchantId},'USD',now())`;
      Object.assign(overrides, { batch: other });
    }
    await expect(item(writer, f, id, overrides)).rejects.toThrow(/Current transaction\/backend/);
    expect(await h.db.sql`select 1 from settlement_items where id=${id}`).toHaveLength(0);
  });
  it.each(['COMMIT', 'IMMEDIATE'] as const)('deferred %s rejects an entirely absent permit/application after same-transaction enrollment', async timing => {
    const f = await fixture(), id = randomUUID();
    await expect(h.db.transaction(async tx => {
      await item(tx, f, id); await enroll(tx, f);
      if (timing === 'IMMEDIATE') await tx`set constraints all immediate`;
    })).rejects.toThrow(/Current transaction\/backend/);
    expect(await h.db.sql`select 1 from settlement_items where id=${id}`).toHaveLength(0);
    expect(await h.db.sql`select 1 from financial_application_scope_authority where merchant_id=${f.a.merchantId}`).toHaveLength(0);
  });
  it.each(['payment', 'attempt', 'currency', 'gross', 'fee', 'net', 'unconfirmed capture', 'missing header'] as const)
  ('the source validator rejects %s independently of permit refusal', async field => {
    const f = await fixture(), id = randomUUID(); await item(writer, f, id);
    const [saved] = await h.db.sql`select to_jsonb(i) row from settlement_items i where id=${id}`;
    const row = { ...(saved.row as Record<string, unknown>) };
    if (field === 'payment') row.payment_id = f.b.paymentId;
    if (field === 'attempt') row.capture_attempt_id = f.b.attemptId;
    if (field === 'currency') row.currency = 'EUR';
    if (field === 'gross') row.gross_amount = 9999;
    if (field === 'fee') row.fee_amount = 299;
    if (field === 'net') row.net_amount = 9699;
    if (field === 'unconfirmed capture') row.capture_attempt_id = f.pending;
    if (field === 'missing header') row.settlement_id = randomUUID();
    // This checks the SQL source predicate, not issuance or successful R2
    // application. The ordinary writer still has no EXECUTE or permit capability.
    await expect(h.db.sql`select public.check_financial_application_item_owner(${h.db.sql.json(row as never)})`).rejects.toThrow(/owned header, payment and original capture journal amounts/);
    expect((await h.db.sql`select to_jsonb(i) row from settlement_items i where id=${id}`)[0]).toEqual(saved);
  });
  it('the source validator accepts the original capture journal after later payment totals change', async () => {
    const f = await fixture(), id = randomUUID(); await item(writer, f, id);
    await captureFixture(h.db, 1000, 30, { merchantId: f.a.merchantId, paymentId: f.a.paymentId });
    const [saved] = await h.db.sql`select to_jsonb(i) row from settlement_items i where id=${id}`;
    await h.db.sql`select public.check_financial_application_item_owner(${h.db.sql.json(saved.row as never)})`;
    expect(await h.db.sql`select 1 from financial_applications`).toHaveLength(0);
  });
  it('deferred journal detection does not depend on an inserted application/root', async () => {
    const f = await fixture(), id = randomUUID();
    await expect(h.db.transaction(async tx => { await draft(tx, id, 'CAPTURE', f.pending, f.b.merchantId); await enroll(tx, f); })).rejects.toThrow(/Current transaction\/backend/);
    expect(await h.db.sql`select 1 from ledger_transactions where id=${id}`).toHaveLength(0);
  });
  it('genuinely unenrolled legacy items and journals still require no R2 permit', async () => {
    const f = await fixture(), id = randomUUID(); await item(writer, f, id);
    await writer`update settlement_items set gross_amount=gross_amount where id=${id}`;
    const journal = randomUUID(); await draft(writer, journal, 'CAPTURE', f.pending, f.a.merchantId);
    expect(await h.db.sql`select 1 from settlement_items where id=${id}`).toHaveLength(1);
    expect(await h.db.sql`select 1 from financial_application_permits`).toHaveLength(0);
  });
});
