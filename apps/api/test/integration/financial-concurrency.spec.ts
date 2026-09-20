import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DatabaseService } from '../../src/database/database.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { PayoutsService } from '../../src/payouts/payouts.service';
import { RefundsService } from '../../src/refunds/refunds.service';
import { WebhookReceiverService } from '../../src/webhooks/webhook-receiver.service';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeDatabase('PostgreSQL financial concurrency', () => {
  let database: DatabaseService;
  let ledger: LedgerService;
  let merchantId: string;
  const actor = () => ({ id: randomUUID(), type: 'API_KEY' as const, merchantId, role: 'MERCHANT_ADMIN' as const });

  beforeAll(async () => {
    database = new DatabaseService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://fintech:fintech@localhost:5432/fintech_lab' }));
    ledger = new LedgerService(database); merchantId = randomUUID();
    await database.sql`insert into merchants (id,name,fee_bps,settlement_delay_days) values (${merchantId},'Concurrency test merchant',300,0)`;
  });

  afterAll(async () => { await database.onApplicationShutdown(); });

  it('rejects an unbalanced posted transaction at commit', async () => {
    await expect(database.transaction(async (tx) => {
      const businessId = randomUUID();
      await tx`insert into ledger_accounts (merchant_id,code,account_type,currency,name) values (${merchantId},'MERCHANT_AVAILABLE','LIABILITY','USD','Available') on conflict do nothing`;
      const [account] = await tx<{id:string}[]>`select id from ledger_accounts where merchant_id=${merchantId} and code='MERCHANT_AVAILABLE' and currency='USD'`;
      const [journal] = await tx<{id:string}[]>`insert into ledger_transactions (merchant_id,business_type,business_id,currency,description,status,posted_at) values (${merchantId},'TEST_UNBALANCED',${businessId},'USD','Must fail','POSTED',now()) returning id`;
      await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) values (${journal.id},${account.id},'USD',0,100)`;
    })).rejects.toThrow(/not balanced/i);
  });

  it('allows only one of two payouts to reserve the same available balance', async () => {
    await database.transaction((tx) => ledger.post(tx, { merchantId, businessType:'TEST_FUNDING', businessId:randomUUID(), currency:'USD', description:'Test available funding', lines:[
      {accountCode:'PLATFORM_CASH',merchantId:null,debit:10_000},{accountCode:'MERCHANT_AVAILABLE',merchantId,credit:10_000},
    ]}));
    const payouts = new PayoutsService(database, new IdempotencyService(database), ledger, new OutboxService(), new AuditService());
    const results = await Promise.allSettled([
      payouts.request(actor(), 'concurrent-payout-a', {amount:8_000,currency:'USD',destinationToken:'bank_mock'}),
      payouts.request(actor(), 'concurrent-payout-b', {amount:8_000,currency:'USD',destinationToken:'bank_mock'}),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await database.transaction((tx) => ledger.merchantBalance(tx, merchantId, 'USD', 'MERCHANT_AVAILABLE'))).toBe(2_000);
  });

  it('prevents concurrent refunds from exceeding captured amount', async () => {
    const paymentId = randomUUID();
    await database.sql`insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,captured_amount,platform_fee_amount,payment_method_token) values (${paymentId},${merchantId},'CAPTURED','MANUAL','USD',1000,1000,1000,30,'pm_test')`;
    const refunds = new RefundsService(database, new IdempotencyService(database), new OutboxService(), new AuditService(), ledger);
    const results = await Promise.allSettled([
      refunds.create(actor(), paymentId, 'concurrent-refund-a', {amount:800,scenario:'SUCCESS'}),
      refunds.create(actor(), paymentId, 'concurrent-refund-b', {amount:800,scenario:'SUCCESS'}),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [row] = await database.sql<{total:string}[]>`select sum(amount)::text as total from refunds where payment_id=${paymentId}`;
    expect(Number(row.total)).toBe(800);
  });

  it('deduplicates two simultaneous deliveries of the same provider event', async () => {
    const receiver = new WebhookReceiverService(new ConfigService({WEBHOOK_SECRET:'test-secret'}), database);
    const raw = JSON.stringify({id:`evt_${randomUUID()}`,type:'unknown.educational',createdAt:new Date().toISOString(),data:{merchantId,paymentId:randomUUID(),providerTransactionId:'none',amount:1,currency:'USD'}});
    const signature = receiver.sign(raw); const results = await Promise.all([receiver.receive(raw,signature),receiver.receive(raw,signature)]);
    expect(results.filter((result)=>result.duplicate)).toHaveLength(1);
  });
});
