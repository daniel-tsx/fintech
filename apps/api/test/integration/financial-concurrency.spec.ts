import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DatabaseService } from '../../src/database/database.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { PayoutsService } from '../../src/payouts/payouts.service';
import { RefundsService } from '../../src/refunds/refunds.service';
import { WebhookReceiverService } from '../../src/webhooks/webhook-receiver.service';
import { WebhookBusinessService } from '../../src/webhooks/webhook-business.service';
import { WebhookProcessorService } from '../../src/webhooks/webhook-processor.service';

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
    await database.sql`insert into payment_attempts (merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id) values (${merchantId},${paymentId},'CAPTURE','SUCCEEDED',1000,'USD','pi_refund_test')`;
    const refunds = new RefundsService(database, new IdempotencyService(database), new OutboxService(), new AuditService(), ledger);
    const results = await Promise.allSettled([
      refunds.create(actor(), paymentId, 'concurrent-refund-a', {amount:800}),
      refunds.create(actor(), paymentId, 'concurrent-refund-b', {amount:800}),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [row] = await database.sql<{total:string}[]>`select sum(amount)::text as total from refunds where payment_id=${paymentId}`;
    expect(Number(row.total)).toBe(800);
  });

  it('deduplicates two simultaneous deliveries of the same provider event', async () => {
    const secret = 'whsec_test_secret'; const stripe = new Stripe('sk_test_placeholder');
    const receiver = new WebhookReceiverService(new ConfigService({STRIPE_WEBHOOK_SECRET:secret}), database, stripe);
    const raw = JSON.stringify({id:`evt_${randomUUID()}`,object:'event',created:Math.floor(Date.now()/1000),type:'customer.created',data:{object:{id:'cus_test'}}});
    const signature = stripe.webhooks.generateTestHeaderString({payload:raw,secret});
    const results = await Promise.all([receiver.receive(Buffer.from(raw),signature),receiver.receive(Buffer.from(raw),signature)]);
    expect(results.filter((result)=>result.duplicate)).toHaveLength(1);
  });

  it('completes capture and posts the ledger only after the signed Stripe webhook is processed', async () => {
    const paymentId = randomUUID(); const attemptId = randomUUID(); const providerIntentId = `pi_${randomUUID().replaceAll('-','')}`;
    await database.sql`insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,captured_amount,platform_fee_amount,payment_method_token) values (${paymentId},${merchantId},'CAPTURE_PENDING','MANUAL','USD',2500,2500,0,0,'pm_test')`;
    await database.sql`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id) values (${attemptId},${merchantId},${paymentId},'CAPTURE','PROCESSING',2500,'USD',${providerIntentId})`;
    await database.sql`insert into provider_transactions (merchant_id,payment_id,payment_attempt_id,provider,provider_transaction_id,payment_intent_id,provider_idempotency_key,operation,status,amount,currency,last_synced_at) values (${merchantId},${paymentId},${attemptId},'STRIPE',${providerIntentId},${providerIntentId},${`capture:${attemptId}`},'CAPTURE','succeeded',2500,'USD',now())`;

    const secret = 'whsec_test_secret'; const stripe = new Stripe('sk_test_placeholder');
    const receiver = new WebhookReceiverService(new ConfigService({STRIPE_WEBHOOK_SECRET:secret}), database, stripe);
    const refunds = new RefundsService(database, new IdempotencyService(database), new OutboxService(), new AuditService(), ledger);
    const business = new WebhookBusinessService(ledger, new OutboxService(), new AuditService(), refunds, new DisputesService(ledger, new AuditService()));
    const processor = new WebhookProcessorService(database, business);
    const raw = JSON.stringify({
      id:`evt_${randomUUID()}`, object:'event', created:Math.floor(Date.now()/1000), type:'payment_intent.succeeded',
      data:{object:{id:providerIntentId,object:'payment_intent',amount:2500,amount_received:2500,currency:'usd',latest_charge:'ch_test',livemode:false,status:'succeeded',metadata:{merchantId,paymentId,captureAttemptId:attemptId,captureAmount:'2500'}}},
    });
    const signature = stripe.webhooks.generateTestHeaderString({payload:raw,secret});
    await receiver.receive(Buffer.from(raw),signature);
    await processor.drain();

    const [payment] = await database.sql<{status:string;captured_amount:string}[]>`select status,captured_amount::text from payments where id=${paymentId}`;
    const [journal] = await database.sql<{total:string}[]>`select count(*)::text as total from ledger_transactions where business_type='CAPTURE' and business_id=${attemptId} and status='POSTED'`;
    expect(payment).toMatchObject({status:'CAPTURED',captured_amount:'2500'});
    expect(Number(journal.total)).toBe(1);
  });
});
