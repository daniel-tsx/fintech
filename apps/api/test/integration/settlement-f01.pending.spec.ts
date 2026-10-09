import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DatabaseService } from '../../src/database/database.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { RefundsService } from '../../src/refunds/refunds.service';
import { SettlementsService } from '../../src/settlements/settlements.service';
import { accountContributions, captureFixture } from '../support/accounting-fixtures';

// These assert the approved CORRECT outcomes and are expected to fail until B2.
const describePending = process.env.RUN_DB_TESTS === '1' && process.env.RUN_F01_PENDING === '1' ? describe : describe.skip;
describePending('F01 correct settlement outcomes (explicitly pending B2)', () => {
  let database: DatabaseService; let refunds: RefundsService; let settlements: SettlementsService; let disputes: DisputesService;
  beforeAll(() => {
    database = new DatabaseService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
    const ledger = new LedgerService(database); const audit = new AuditService();
    refunds = new RefundsService(database,new IdempotencyService(database),new OutboxService(),audit,ledger);
    settlements = new SettlementsService(database,ledger,audit); disputes = new DisputesService(ledger,audit);
  });
  afterAll(async () => { await database.onApplicationShutdown(); });
  async function refund(fixture: Awaited<ReturnType<typeof captureFixture>>, amount: number) {
    const result = await refunds.create({ id:'test',type:'API_KEY',merchantId:fixture.merchantId,role:'MERCHANT_ADMIN' },fixture.paymentId,`refund-${amount}`,{amount});
    const refundId = String(result.value.id);
    await database.transaction((tx) => refunds.applySucceeded(tx,{merchantId:fixture.merchantId,paymentId:fixture.paymentId,refundId,providerTransactionId:`re_${refundId}`,amount,currency:'USD'}));
  }
  async function complete(merchantId: string, id?: string) {
    const settlementId = id ?? (await settlements.generate(merchantId))[0];
    expect(settlementId).toBeDefined(); await database.transaction((tx) => settlements.complete(tx,settlementId));
    return database.transaction((tx) => accountContributions(tx,merchantId));
  }
  it('A: settles only the remaining asset5000 and claim4850 after a partial refund', async () => {
    const fixture = await captureFixture(database); await refund(fixture,5000);
    expect(await complete(fixture.merchantId)).toMatchObject({ PSP_CLEARING:'0',PLATFORM_CASH:'5000',MERCHANT_PENDING:'0',MERCHANT_AVAILABLE:'4850' });
  });
  it('B: produces no financial journal or payoutable funds after a full refund', async () => {
    const fixture = await captureFixture(database); await refund(fixture,10000);
    const id = (await settlements.generate(fixture.merchantId))[0]; const balances = await complete(fixture.merchantId,id);
    expect({ ...balances, MERCHANT_AVAILABLE:balances.MERCHANT_AVAILABLE ?? '0', PLATFORM_CASH:balances.PLATFORM_CASH ?? '0' })
      .toMatchObject({ PSP_CLEARING:'0',PLATFORM_CASH:'0',MERCHANT_PENDING:'0',MERCHANT_AVAILABLE:'0' });
    const [row] = await database.sql<{count:number}[]>`select count(*)::integer as count from ledger_transactions where business_type='SETTLEMENT' and business_id=${id}`;
    expect(row.count).toBe(0);
  });
  it('C: retains a funded5000 dispute while releasing only4700', async () => {
    const fixture = await captureFixture(database);
    await database.transaction((tx) => disputes.open(tx,{merchantId:fixture.merchantId,paymentId:fixture.paymentId,providerDisputeId:`dp_${fixture.paymentId}`,amount:5000,currency:'USD'}));
    expect(await complete(fixture.merchantId)).toMatchObject({ PSP_CLEARING:'0',PLATFORM_CASH:'10000',MERCHANT_PENDING:'0',MERCHANT_AVAILABLE:'4700',DISPUTE_CLEARING:'5000' });
  });
  it.each(['refund','dispute'])('D: recalculates a candidate made stale by %s', async (event) => {
    const fixture = await captureFixture(database); const id = (await settlements.generate(fixture.merchantId))[0];
    if (event === 'refund') await refund(fixture,5000);
    else await database.transaction((tx) => disputes.open(tx,{merchantId:fixture.merchantId,paymentId:fixture.paymentId,providerDisputeId:`dp_${fixture.paymentId}`,amount:5000,currency:'USD'}));
    expect(await complete(fixture.merchantId,id)).toMatchObject({ MERCHANT_PENDING:'0',MERCHANT_AVAILABLE:event==='refund'?'4850':'4700',PLATFORM_CASH:event==='refund'?'5000':'10000' });
  });
  it('E: attributes a5000 refund to settled A4000 and pending B1000', async () => {
    const a = await captureFixture(database,4000,120); await complete(a.merchantId);
    const b = await captureFixture(database,6000,180,a); await refund(b,5000);
    expect(await database.transaction((tx) => accountContributions(tx,a.merchantId)))
      .toMatchObject({ PSP_CLEARING:'5000',PLATFORM_CASH:'0',MERCHANT_PENDING:'4850',MERCHANT_AVAILABLE:'0',PLATFORM_FEE_REFUNDS:'150' });
  });
});
