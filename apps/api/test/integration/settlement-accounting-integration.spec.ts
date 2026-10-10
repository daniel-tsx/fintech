import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DatabaseService } from '../../src/database/database.service';
import { CaptureDisputeAccountingService } from '../../src/disputes/capture-dispute-accounting.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { PayoutsService } from '../../src/payouts/payouts.service';
import { CaptureRefundAccountingService } from '../../src/refunds/capture-refund-accounting.service';
import { RefundsService } from '../../src/refunds/refunds.service';
import { CaptureSettlementAccountingService } from '../../src/settlements/capture-settlement-accounting.service';
import { SettlementsService } from '../../src/settlements/settlements.service';
import { WebhookBusinessService } from '../../src/webhooks/webhook-business.service';
import type { ProviderEvent } from '../../src/webhooks/webhook.types';
import { accountContributions, captureFixture } from '../support/accounting-fixtures';

const describeDatabase=process.env.RUN_DB_TESTS==='1'?describe:describe.skip;
type Capture=Awaited<ReturnType<typeof captureFixture>> & {lotId:string};
interface BatchEvidence {
  status:string; gross_amount:string; fee_amount:string; net_amount:string; estimated_asset_transfer:string; estimated_merchant_release:string;
  finalized_asset_transfer:string; finalized_merchant_release:string; finalization_result:string; accounting_journal_id:string|null;
  accounting_finalized_at:Date; provider_reference:string|null;
}
interface ItemEvidence {
  id:string; capture_lot_id:string; capture_attempt_id:string; payment_id:string; gross_amount:string; fee_amount:string; net_amount:string;
  selected_revision:string; applied_revision:string; allocation_revision:string; finalized_asset_transfer:string; finalized_merchant_release:string;
  restricted_hold:string; finalization_result:string; accounting_journal_id:string|null; accounting_finalized_at:Date;
  settlement_state:string; finalized_settlement_item_id:string;
}
// These subclasses are test-only admission, not an environment switch in a writer.
class DormantSettlement extends CaptureSettlementAccountingService {
  protected assertActiveScope(status:string):void {if(!['FOUNDATION_ONLY','REVIEW_REQUIRED'].includes(status)) throw new Error('Missing dormant fixture scope');}
}
class DormantRefund extends CaptureRefundAccountingService {
  protected assertActiveScope(status:string):void {if(!['FOUNDATION_ONLY','REVIEW_REQUIRED'].includes(status)) throw new Error('Missing dormant fixture scope');}
}
class DormantDispute extends CaptureDisputeAccountingService {
  protected assertActiveScope(status:string):void {if(!['FOUNDATION_ONLY','REVIEW_REQUIRED'].includes(status)) throw new Error('Missing dormant fixture scope');}
}

describeDatabase('B2.4 dormant capture settlement transactions (legacy F01 remains separate)',()=>{
  let database:DatabaseService,ledger:LedgerService,audit:AuditService,settlements:DormantSettlement,refunds:DormantRefund,disputes:DormantDispute;
  let payouts:PayoutsService,business:WebhookBusinessService;
  beforeAll(()=>{
    database=new DatabaseService(new ConfigService({DATABASE_URL:process.env.DATABASE_URL}));ledger=new LedgerService(database);audit=new AuditService();
    const idempotency=new IdempotencyService(database),outbox=new OutboxService();
    settlements=new DormantSettlement(database,ledger,audit);refunds=new DormantRefund(database,idempotency,outbox,audit,ledger);
    disputes=new DormantDispute(ledger,audit);payouts=new PayoutsService(database,idempotency,ledger,outbox,audit);
    business=new WebhookBusinessService(ledger,outbox,audit,new RefundsService(database,idempotency,outbox,audit,ledger),new DisputesService(ledger,audit));
  });
  afterAll(async()=>{await database.onApplicationShutdown();});
  const actor=(f:Capture)=>({id:randomUUID(),type:'API_KEY' as const,role:'MERCHANT_ADMIN' as const,merchantId:f.merchantId});
  async function capture(gross=10000,fee=300,scope?:{merchantId:string;paymentId:string},delay=0,legacy=false):Promise<Capture> {
    const f=await captureFixture(database,gross,fee,scope);
    await database.sql`insert into public.capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD') on conflict do nothing`;
    const [lot]=await database.sql<{id:string}[]>`insert into public.capture_accounting_lots
      (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at,origin)
      select ${f.attemptId},${f.paymentId},${f.merchantId},'USD',id,${gross},${fee},${gross-fee},posted_at,
        posted_at+${delay}*interval '24 hours',${legacy?'LEGACY_ORIGINAL_ONLY':'NEW_CAPTURE'} from public.ledger_transactions where id=${f.journalId} returning id`;
    return {...f,lotId:lot.id};
  }
  async function anotherPayment(f:Capture,gross=10000,fee=300) {
    const paymentId=randomUUID();
    await database.sql`insert into public.payments (id,merchant_id,status,capture_method,currency,amount,payment_method_token)
      values (${paymentId},${f.merchantId},'CAPTURED','MANUAL','USD',1,'pm_test')`;
    return capture(gross,fee,{merchantId:f.merchantId,paymentId});
  }
  async function evidence(f:Capture,type:'refund.succeeded'|'dispute.opened'|'dispute.closed',reference:string,amount:number,outcome?:'MERCHANT_WON'|'MERCHANT_LOST') {
    const event:ProviderEvent={id:`evt_${randomUUID()}`,type,externalType:type,createdAt:new Date(0).toISOString(),data:{merchantId:f.merchantId,paymentId:f.paymentId,
      providerTransactionId:type==='refund.succeeded'?`re_${reference}`:reference,paymentIntentId:`pi_${f.paymentId}`,amount,currency:'USD',
      ...(type==='refund.succeeded'?{refundId:reference}:{providerDisputeId:reference,outcome})}};
    const [row]=await database.sql<{id:string}[]>`insert into public.webhook_events (provider,provider_event_id,event_type,signature,payload,status)
      values ('STRIPE',${event.id},${type},'isolated-fixture',${database.sql.json(event as never)},'IGNORED') returning id`;
    return row.id;
  }
  const complete=(id:string)=>database.transaction(tx=>settlements.complete(tx,id));
  const generate=(f:Capture)=>settlements.generate(f.merchantId,'USD');
  async function candidate(f:Capture) {const ids=await generate(f);expect(ids).toHaveLength(1);return ids[0];}
  async function request(f:Capture,amount:number) {return (await refunds.create(actor(f),f.paymentId,randomUUID(),{amount})).value.id;}
  async function refund(f:Capture,amount:number) {const r=await request(f,amount),id=await evidence(f,'refund.succeeded',r,amount);expect(await database.transaction(tx=>refunds.applySucceeded(tx,id))).toBe('PROCESSED');return {r,id};}
  async function open(f:Capture,amount=5000) {const provider=`dp_${randomUUID()}`,id=await evidence(f,'dispute.opened',provider,amount);
    expect(await database.transaction(tx=>disputes.applyOpened(tx,id))).toBe('PROCESSED');return {provider,amount};}
  async function close(f:Capture,d:Awaited<ReturnType<typeof open>>,outcome:'MERCHANT_WON'|'MERCHANT_LOST') {
    const id=await evidence(f,'dispute.closed',d.provider,d.amount,outcome);expect(await database.transaction(tx=>disputes.applyClosed(tx,id))).toBe('PROCESSED');return id;
  }
  async function balances(f:Capture,values:Array<number|string>) {
    const codes=['PSP_CLEARING','PLATFORM_CASH','MERCHANT_PENDING','MERCHANT_AVAILABLE','DISPUTE_CLEARING','PLATFORM_FEE_REVENUE','PLATFORM_FEE_REFUNDS','PAYOUT_CLEARING'];
    const actual=await database.transaction(tx=>accountContributions(tx,f.merchantId));
    expect(codes.map(code=>actual[code]??'0')).toEqual([...values,...Array<number>(8-values.length).fill(0)].map(String));
  }
  async function snapshot(f:Capture) {
    const [row]=await database.sql`select
      (select jsonb_agg(to_jsonb(s) order by id) from public.settlements s where merchant_id=${f.merchantId}) as batches,
      (select jsonb_agg(to_jsonb(i) order by i.id) from public.settlement_items i join public.settlements s on s.id=i.settlement_id where s.merchant_id=${f.merchantId}) as items,
      (select jsonb_agg(to_jsonb(l) order by id) from public.capture_accounting_lots l where merchant_id=${f.merchantId}) as lots,
      (select jsonb_agg(to_jsonb(t) order by id) from public.ledger_transactions t where merchant_id=${f.merchantId}) as journals,
      (select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_entries e join public.ledger_transactions t on t.id=e.transaction_id where t.merchant_id=${f.merchantId}) as entries,
      (select jsonb_agg(to_jsonb(a) order by id) from public.audit_logs a where merchant_id=${f.merchantId}) as audits`;
    return row;
  }
  async function finalEvidence(id:string,asset:number|string,release:number|string,held:number|string=0) {
    const result=BigInt(asset)||BigInt(release)?'POSTED':'ZERO_EFFECT';
    const [batch]=await database.sql<BatchEvidence[]>`select status,gross_amount::text,fee_amount::text,net_amount::text,estimated_asset_transfer::text,estimated_merchant_release::text,
      finalized_asset_transfer::text,finalized_merchant_release::text,finalization_result,accounting_journal_id,accounting_finalized_at,provider_reference from public.settlements where id=${id}`;
    expect(batch).toMatchObject({status:'SUCCEEDED',finalized_asset_transfer:String(asset),finalized_merchant_release:String(release),finalization_result:result,provider_reference:null});
    expect(batch.accounting_finalized_at).toBeInstanceOf(Date);
    const rows=await database.sql<ItemEvidence[]>`select i.*,l.settlement_state,l.finalized_settlement_item_id,l.allocation_revision from public.settlement_items i
      join public.capture_accounting_lots l on l.id=i.capture_lot_id where settlement_id=${id}`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((sum,r)=>sum+BigInt(r.finalized_asset_transfer),0n)).toBe(BigInt(asset));
    expect(rows.reduce((sum,r)=>sum+BigInt(r.finalized_merchant_release),0n)).toBe(BigInt(release));
    expect(rows.reduce((sum,r)=>sum+BigInt(r.restricted_hold),0n)).toBe(BigInt(held));
    for(const row of rows) {
      expect(row.settlement_state).toBe('FINALIZED');expect(row.finalized_settlement_item_id).toBe(row.id);
      expect(row.applied_revision).toBe(row.allocation_revision);expect(row.accounting_finalized_at).toBeInstanceOf(Date);
      expect(row.accounting_journal_id).toBe(row.finalization_result==='POSTED'?batch.accounting_journal_id:null);
    }
    const journals=await database.sql`select id,status from public.ledger_transactions where business_type='SETTLEMENT' and business_id=${id}`;
    expect(journals).toEqual(result==='POSTED'?[{id:batch.accounting_journal_id,status:'POSTED'}]:[]);
    const lines=await database.sql`select a.code,sum(e.debit)::text as debit,sum(e.credit)::text as credit from public.ledger_entries e
      join public.ledger_accounts a on a.id=e.account_id where transaction_id=${batch.accounting_journal_id} group by a.code order by a.code`;
    expect(lines).toEqual([
      ...(BigInt(release)?[{code:'MERCHANT_AVAILABLE',debit:'0',credit:String(release)},{code:'MERCHANT_PENDING',debit:String(release),credit:'0'}]:[]),
      ...(BigInt(asset)?[{code:'PLATFORM_CASH',debit:String(asset),credit:'0'},{code:'PSP_CLEARING',debit:'0',credit:String(asset)}]:[]),
    ]);
    const audits=await database.sql`select action from public.audit_logs where target_id=${id} order by action`;
    expect(audits).toEqual([{action:'settlement.completed'},{action:'settlement.generated'}]);
    return {batch,rows};
  }

  it('refuses real admission, keeps schema dormant and creates no candidate',async()=>{
    const f=await capture();await expect(new CaptureSettlementAccountingService(database,ledger,audit).generate(f.merchantId)).rejects.toMatchObject({code:'ACCOUNTING_SCOPE_INACTIVE'});
    expect((await database.sql`select id from public.settlements where merchant_id=${f.merchantId}`)).toHaveLength(0);
    const [row]=await database.sql`select count(*)::integer as count from public.capture_accounting_scopes where status='ACTIVE'`;expect(row.count).toBe(0);
  });
  it('A: posts independent asset and liability pairs for a normal mature capture',async()=>{
    const f=await capture(),id=await candidate(f);expect(await complete(id)).toBe('PROCESSED');
    await balances(f,[0,10000,0,9700,0,300,0]);const {batch,rows}=await finalEvidence(id,10000,9700);
    expect(batch).toMatchObject({gross_amount:'10000',fee_amount:'300',net_amount:'9700',estimated_asset_transfer:'10000',estimated_merchant_release:'9700'});
    expect(rows[0]).toMatchObject({capture_lot_id:f.lotId,capture_attempt_id:f.attemptId,payment_id:f.paymentId,gross_amount:'10000',fee_amount:'300',net_amount:'9700'});
  });
  it.each(['USD','EUR'])('actual B2.1 capture transaction feeds settlement without synthetic lot creation (%s)',async currency=>{
    const merchantId=randomUUID(),paymentId=randomUUID(),attemptId=randomUUID(),provider=`pi_${paymentId}`;
    await database.sql`insert into public.merchants (id,name,fee_bps,settlement_delay_days) values (${merchantId},'B2.4 actual capture',300,0)`;
    await database.sql`insert into public.payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,payment_method_token)
      values (${paymentId},${merchantId},'CAPTURE_PENDING','MANUAL',${currency},10000,10000,'pm_test')`;
    await database.sql`insert into public.payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency) values (${attemptId},${merchantId},${paymentId},'CAPTURE','PROCESSING',10000,${currency})`;
    const event:ProviderEvent={id:`evt_${randomUUID()}`,type:'payment.capture_succeeded',externalType:'charge.captured',createdAt:new Date(0).toISOString(),
      data:{merchantId,paymentId,attemptId,providerTransactionId:provider,paymentIntentId:provider,amount:10000,currency}};
    await database.transaction(tx=>business.handle(tx,event));const [lot]=await database.sql<{id:string;capture_journal_id:string}[]>`select id,capture_journal_id from public.capture_accounting_lots where capture_attempt_id=${attemptId}`;
    const f={merchantId,paymentId,attemptId,lotId:lot.id,journalId:lot.capture_journal_id,gross:10000,fee:300};
    const [id]=await settlements.generate(merchantId,currency);expect(id).toBeDefined();await complete(id);await finalEvidence(id,10000,9700);
    await balances(f,[0,10000,0,9700,0,300,0]);const [row]=await database.sql`select currency from public.settlements where id=${id}`;expect(row.currency).toBe(currency);
  });
  it('generation creates only candidate and audit evidence, leaving every account and lot unsettled',async()=>{
    const f=await capture(),id=await candidate(f);await balances(f,[10000,0,9700,0,0,300,0]);
    const [row]=await database.sql`select s.status,s.finalization_result,l.settlement_state,i.selected_revision,i.finalization_result as item_result
      from public.settlements s join public.settlement_items i on i.settlement_id=s.id join public.capture_accounting_lots l on l.id=i.capture_lot_id where s.id=${id}`;
    expect(row).toEqual({status:'PENDING',finalization_result:null,settlement_state:'UNSETTLED',selected_revision:'0',item_result:null});
    expect(await database.sql`select id from public.ledger_transactions where business_type='SETTLEMENT' and business_id=${id}`).toHaveLength(0);
    expect(await database.sql`select action from public.audit_logs where target_id=${id}`).toEqual([{action:'settlement.generated'}]);
  });
  it.each([false,true])('B/E: confirms partial refund with exact fee and fresh completion (stale=%s)',async stale=>{
    const f=await capture();let id=stale?await candidate(f):'';await refund(f,5000);id||=await candidate(f);await complete(id);
    await balances(f,[0,5000,0,4850,0,300,150]);const {batch,rows}=await finalEvidence(id,5000,4850);
    expect(batch.estimated_asset_transfer).toBe(stale?'10000':'5000');expect(batch.estimated_merchant_release).toBe(stale?'9700':'4850');
    expect(BigInt(rows[0].applied_revision)).toBeGreaterThanOrEqual(BigInt(rows[0].selected_revision));
  });
  it.each([false,true])('C: full refund finalizes ZERO_EFFECT without a journal (stale=%s)',async stale=>{
    const f=await capture();let id=stale?await candidate(f):'';await refund(f,10000);id||=await candidate(f);await complete(id);
    await balances(f,[0,0,0,0,0,300,300]);await finalEvidence(id,0,0);const before=await snapshot(f);
    expect(await complete(id)).toBe('PROCESSED');expect(await snapshot(f)).toEqual(before);expect(await generate(f)).toEqual([]);
  });
  it.each([false,true])('D/F: funded dispute restricts only merchant release (stale=%s)',async stale=>{
    const f=await capture();let id=stale?await candidate(f):'';await open(f);id||=await candidate(f);await complete(id);
    await balances(f,[0,10000,0,4700,5000,300,0]);const {batch}=await finalEvidence(id,10000,4700,5000);
    expect(batch.estimated_merchant_release).toBe(stale?'9700':'4700');
  });
  it('G: FIFO refund uses finalized A cash and unsettled B PSP without settling A again',async()=>{
    const a=await capture(4000,120),first=await candidate(a);await complete(first);const saved=await database.sql`select * from public.settlement_items where settlement_id=${first}`;
    const b=await capture(6000,180,a);await refund(b,5000);await balances(a,[5000,0,4850,0,0,300,150]);
    const id=await candidate(b);await complete(id);await balances(a,[0,5000,0,4850,0,300,150]);await finalEvidence(id,5000,4850);
    expect(await database.sql`select * from public.settlement_items where settlement_id=${first}`).toEqual(saved);expect(await complete(first)).toBe('PROCESSED');
    const allocations=await database.sql`select capture_lot_id,confirmed_gross::text,confirmed_fee::text from public.refund_capture_allocations where payment_id=${a.paymentId} order by confirmed_gross desc`;
    expect(allocations).toEqual([{capture_lot_id:a.lotId,confirmed_gross:'4000',confirmed_fee:'120'},{capture_lot_id:b.lotId,confirmed_gross:'1000',confirmed_fee:'30'}]);
  });
  it.each(['MERCHANT_WON','MERCHANT_LOST'] as const)('H/I: %s after settlement changes cash/claim without a second settlement',async outcome=>{
    const f=await capture(),d=await open(f),id=await candidate(f);await complete(id);await finalEvidence(id,10000,4700,5000);
    const saved=await database.sql`select * from public.settlement_items where settlement_id=${id}`;await close(f,d,outcome);
    await balances(f,outcome==='MERCHANT_WON'?[0,10000,0,9700,0,300,0]:[0,5000,0,4700,0,300,0]);
    expect(await complete(id)).toBe('PROCESSED');expect(await database.sql`select * from public.settlement_items where settlement_id=${id}`).toEqual(saved);
    expect(await generate(f)).toEqual([]);
  });
  it('J: full dispute settles only asset; later loss explains available debt',async()=>{
    const f=await capture(),d=await open(f,10000),id=await candidate(f);await complete(id);await finalEvidence(id,10000,0,9700);
    await balances(f,[0,10000,0,0,9700,300,0]);await close(f,d,'MERCHANT_LOST');await balances(f,[0,0,0,-300,0,300,0]);expect(await complete(id)).toBe('PROCESSED');
  });
  it.each(['MERCHANT_WON','MERCHANT_LOST'] as const)('recalculates a candidate after dispute closes before completion (%s)',async outcome=>{
    const f=await capture(),d=await open(f),id=await candidate(f);await close(f,d,outcome);await complete(id);
    await finalEvidence(id,outcome==='MERCHANT_WON'?10000:5000,outcome==='MERCHANT_WON'?9700:4700);
    await balances(f,outcome==='MERCHANT_WON'?[0,10000,0,9700,0,300,0]:[0,5000,0,4700,0,300,0]);
  });
  it('full loss before settlement creates zero effect and preserves explained debt',async()=>{
    const f=await capture(),d=await open(f,10000);await close(f,d,'MERCHANT_LOST');const id=await candidate(f);await complete(id);
    await finalEvidence(id,0,0);await balances(f,[0,0,0,-300,0,300,0]);
  });
  it('generation/refund/dispute completion uses hold adjustment evidence and actual estimates',async()=>{
    const f=await capture(),id=await candidate(f);await refund(f,5000);await open(f,5000);await complete(id);
    await finalEvidence(id,5000,0,4850);await balances(f,[0,5000,0,0,4850,300,150]);
  });
  it('multiple disjoint disputes and refund reductions preserve exact restricted holds',async()=>{
    const f=await capture(),a=await open(f,5000),b=await open(f,4500),id=await candidate(f);await refund(f,500);await complete(id);
    await finalEvidence(id,9500,0,9215);await balances(f,[0,9500,0,0,9215,300,15]);await close(f,b,'MERCHANT_WON');await close(f,a,'MERCHANT_LOST');
    await balances(f,[0,4500,0,4215,0,300,15]);expect(await complete(id)).toBe('PROCESSED');
  });
  it('pending refund reserves capacity but not a posted financial subtraction (Option A)',async()=>{
    const f=await capture(),r=await request(f,5000),id=await candidate(f);await complete(id);await finalEvidence(id,10000,9700);
    const inbox=await evidence(f,'refund.succeeded',r,5000);expect(await database.transaction(tx=>refunds.applySucceeded(tx,inbox))).toBe('PROCESSED');
    await balances(f,[0,5000,0,4850,0,300,150]);expect(await complete(id)).toBe('PROCESSED');
  });
  it('post-settlement dispute open and loss debit current available/cash',async()=>{
    const f=await capture(),id=await candidate(f);await complete(id);const d=await open(f);await balances(f,[0,10000,0,4700,5000,300,0]);
    await close(f,d,'MERCHANT_LOST');await balances(f,[0,5000,0,4700,0,300,0]);expect(await complete(id)).toBe('PROCESSED');
  });
  it('exact cumulative tiny refund fees survive stale completion',async()=>{
    const f=await capture(10,3),id=await candidate(f);await refund(f,1);await refund(f,2);await refund(f,4);await complete(id);
    await finalEvidence(id,3,2);await balances(f,[0,3,0,2,0,3,2]);
  });
  it('a 100% original fee posts only positive asset legs',async()=>{
    const f=await capture(100,100),id=await candidate(f);await complete(id);await finalEvidence(id,100,0);await balances(f,[0,100,0,0,0,100,0]);
  });
  it('does not consume another capture pending claim for unfunded exposure',async()=>{
    const a=await capture(4000,120);await capture(6000,180,a);const d=await open(a,4000);await close(a,d,'MERCHANT_LOST');const id=await candidate(a);await complete(id);
    await finalEvidence(id,6000,5820);await balances(a,[0,6000,0,5700,0,300,0]);
    const items=await database.sql`select capture_lot_id,finalized_asset_transfer::text,finalized_merchant_release::text,finalization_result from public.settlement_items where settlement_id=${id} order by gross_amount`;
    expect(items).toEqual([{capture_lot_id:a.lotId,finalized_asset_transfer:'0',finalized_merchant_release:'0',finalization_result:'ZERO_EFFECT'},
      expect.objectContaining({finalized_asset_transfer:'6000',finalized_merchant_release:'5820',finalization_result:'POSTED'})]);
  });
  it('locks a multi-payment batch and finalizes exact inserted-item totals',async()=>{
    const a=await capture(),b=await anotherPayment(a,4000,120);await refund(b,2000);const id=await candidate(a);await complete(id);
    const {batch,rows}=await finalEvidence(id,12000,11640);expect(rows).toHaveLength(2);expect(batch).toMatchObject({gross_amount:'14000',fee_amount:'420',net_amount:'13580'});
    await balances(a,[0,12000,0,11640,0,420,60]);
  });
  it('duplicate generation skips an owned item and totals only newly inserted captures',async()=>{
    const a=await capture(4000,120),first=await candidate(a);expect(await generate(a)).toEqual([]);const b=await capture(6000,180,a),second=await candidate(b);
    const [row]=await database.sql`select gross_amount::text,fee_amount::text,net_amount::text from public.settlements where id=${second}`;
    expect(row).toEqual({gross_amount:'6000',fee_amount:'180',net_amount:'5820'});await complete(first);await complete(second);await balances(a,[0,10000,0,9700,0,300,0]);
  });
  it('current merchant delay does not change frozen mature eligibility',async()=>{
    const f=await capture();await database.sql`update public.merchants set settlement_delay_days=90 where id=${f.merchantId}`;
    const id=await candidate(f);await complete(id);await finalEvidence(id,10000,9700);
  });
  it('future frozen eligibility stays ineligible even after merchant delay is shortened',async()=>{
    const f=await capture(10000,300,undefined,10);await database.sql`update public.merchants set settlement_delay_days=0 where id=${f.merchantId}`;
    expect(await generate(f)).toEqual([]);expect((await snapshot(f)).batches).toBeNull();await balances(f,[10000,0,9700,0,0,300,0]);
  });
  it('empty and wrong-currency scope creates no phantom batch',async()=>{
    const f=await capture();expect(await settlements.generate(randomUUID(),'USD')).toEqual([]);expect(await settlements.generate(f.merchantId,'EUR')).toEqual([]);
    expect((await snapshot(f)).batches).toBeNull();
  });
  it('legacy-origin evidence is never silently authorized and review evidence is idempotent',async()=>{
    const f=await capture(10000,300,undefined,0,true);expect(await generate(f)).toEqual([]);expect(await generate(f)).toEqual([]);
    const exceptions=await database.sql`select status,observed_conflict from public.accounting_exceptions where merchant_id=${f.merchantId}`;
    expect(exceptions).toHaveLength(1);expect(exceptions[0]).toMatchObject({status:'OPEN',observed_conflict:{captures:[expect.objectContaining({lotId:f.lotId,journalId:f.journalId})]}});
    await balances(f,[10000,0,9700,0,0,300,0]);
  });
  it('unallocated historical successful capture blocks new capture eligibility',async()=>{
    const old=await captureFixture(database,4000,120),f=await capture(6000,180,old);expect(await generate(f)).toEqual([]);
    const [row]=await database.sql`select status from public.capture_accounting_scopes where merchant_id=${f.merchantId}`;expect(row.status).toBe('REVIEW_REQUIRED');
    await balances(f,[10000,0,9700,0,0,300,0]);
  });
  it.each([false,true])('preserves existing legacy settlement evidence (completed=%s)',async done=>{
    const f=await capture(),legacy=new SettlementsService(database,ledger,audit),id=(await legacy.generate(f.merchantId))[0];
    if(done) await database.transaction(tx=>legacy.complete(tx,id));const before=await snapshot(f);
    await expect(complete(id)).rejects.toMatchObject({code:'LEGACY_SETTLEMENT_REVIEW_REQUIRED'});expect(await snapshot(f)).toEqual(before);expect(await generate(f)).toEqual([]);
  });
  it.each(['generation','completion'] as const)('known unapplied confirmed inbox evidence blocks %s without zero-effect concealment',async phase=>{
    const f=await capture();await refund(f,10000);const id=phase==='completion'?await candidate(f):null;
    const inbox=await evidence(f,'dispute.opened',`dp_${randomUUID()}`,1);await database.sql`update public.webhook_events set status='PENDING' where id=${inbox}`;
    const before=await snapshot(f);await expect(id?complete(id):generate(f)).rejects.toMatchObject({code:'ACCOUNTING_PREREQUISITE_PENDING'});expect(await snapshot(f)).toEqual(before);
  });
  it('one item exception blocks the whole batch, preserving all original candidate evidence',async()=>{
    const a=await capture(),b=await anotherPayment(a),id=await candidate(a);const inbox=await evidence(b,'dispute.opened',`dp_${randomUUID()}`,10001);
    expect(await database.transaction(tx=>disputes.applyOpened(tx,inbox))).toBe('ACCOUNTING_EXCEPTION');const before=await snapshot(a);
    expect(await complete(id)).toBe('ACCOUNTING_EXCEPTION');expect(await complete(id)).toBe('ACCOUNTING_EXCEPTION');expect(await snapshot(a)).toEqual(before);
    await balances(a,[20000,0,19400,0,0,600,0]);
  });
  it('contradictory confirmed parent history requires durable review, not successful completion',async()=>{
    const f=await capture(),id=await candidate(f);await database.sql`update public.payments set refunded_amount=1 where id=${f.paymentId}`;
    expect(await complete(id)).toBe('ACCOUNTING_EXCEPTION');expect(await complete(id)).toBe('ACCOUNTING_EXCEPTION');
    const [row]=await database.sql`select status,finalization_result from public.settlements where id=${id}`;expect(row).toEqual({status:'PENDING',finalization_result:null});
    await balances(f,[10000,0,9700,0,0,300,0]);
  });
  it('capture attempt success must still agree with immutable original evidence at completion',async()=>{
    const f=await capture(),id=await candidate(f);await database.sql`update public.payment_attempts set status='FAILED' where id=${f.attemptId}`;
    expect(await complete(id)).toBe('ACCOUNTING_EXCEPTION');await balances(f,[10000,0,9700,0,0,300,0]);
    const [row]=await database.sql`select status from public.settlements where id=${id}`;expect(row.status).toBe('PENDING');
  });
  it('cross-merchant/currency candidate mutations are rejected without damaging valid evidence',async()=>{
    const f=await capture(),other=await capture(),id=await candidate(f),before=await snapshot(f);
    await expect(database.sql`update public.settlement_items set payment_id=${other.paymentId} where settlement_id=${id}`).rejects.toThrow();
    await expect(database.sql`update public.settlement_items set currency='EUR' where settlement_id=${id}`).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);await complete(id);await finalEvidence(id,10000,9700);
  });
  it.each(['USD','EUR'])('an unapplied preexisting %s journal forces review rather than a second posting or guessed finalization',async currency=>{
    const f=await capture(),id=await candidate(f);
    await database.transaction(tx=>ledger.post(tx,{merchantId:f.merchantId,businessType:'SETTLEMENT',businessId:id,currency,description:'Unapplied prior evidence',
      lines:[{accountCode:'PLATFORM_CASH',merchantId:null,debit:1},{accountCode:'PSP_CLEARING',merchantId:null,credit:1}]}));
    const before=await database.sql`select id from public.ledger_transactions where business_type='SETTLEMENT' and business_id=${id}`;
    expect(await complete(id)).toBe('ACCOUNTING_EXCEPTION');expect(await database.sql`select id from public.ledger_transactions where business_type='SETTLEMENT' and business_id=${id}`).toEqual(before);
    const [row]=await database.sql`select finalization_result from public.settlements where id=${id}`;expect(row.finalization_result).toBeNull();
  });
  it('inconsistent pending batch originals require review and cannot become finalized evidence',async()=>{
    const f=await capture(),id=await candidate(f);await database.sql`update public.settlements set gross_amount=1 where id=${id}`;
    expect(await complete(id)).toBe('ACCOUNTING_EXCEPTION');await balances(f,[10000,0,9700,0,0,300,0]);
    const [row]=await database.sql`select status,finalization_result from public.settlements where id=${id}`;expect(row).toEqual({status:'PENDING',finalization_result:null});
  });
  it.each(['journal','audit'] as const)('rolls back all settlement financial/finalization evidence on %s failure then retries',async point=>{
    const f=await capture(),id=await candidate(f),before=await snapshot(f);
    const spy=point==='journal'?jest.spyOn(ledger,'post').mockImplementationOnce(async(tx,input)=>{await LedgerService.prototype.post.call(ledger,tx,input);throw new Error('Injected journal failure');})
      :jest.spyOn(audit,'append').mockImplementationOnce(()=>Promise.reject(new Error('Injected audit failure')));
    try{await expect(complete(id)).rejects.toThrow('Injected');}finally{spy.mockRestore();}
    expect(await snapshot(f)).toEqual(before);expect(await complete(id)).toBe('PROCESSED');await finalEvidence(id,10000,9700);
  });
  it('generation audit failure rolls back header and members rather than leaving a phantom owner',async()=>{
    const f=await capture(),before=await snapshot(f);const spy=jest.spyOn(audit,'append').mockRejectedValueOnce(new Error('Injected generation failure'));
    try{await expect(generate(f)).rejects.toThrow('Injected');}finally{spy.mockRestore();}expect(await snapshot(f)).toEqual(before);
    const id=await candidate(f);await complete(id);await finalEvidence(id,10000,9700);
  });
  it('deferred constraints refuse incomplete successful finalization and preserve pending evidence',async()=>{
    const f=await capture(),id=await candidate(f),before=await snapshot(f);
    await expect(database.transaction(async tx=>{await tx`update public.settlements set status='SUCCEEDED',finalization_result='ZERO_EFFECT',finalized_asset_transfer=0,finalized_merchant_release=0,accounting_finalized_at=now() where id=${id}`;})).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);await complete(id);await finalEvidence(id,10000,9700);
  });
  it('replay preserves finalized snapshots after later refunds and new blocking exceptions',async()=>{
    const f=await capture(),id=await candidate(f);await complete(id);await refund(f,5000);const inbox=await evidence(f,'dispute.opened',`dp_${randomUUID()}`,10001);
    expect(await database.transaction(tx=>disputes.applyOpened(tx,inbox))).toBe('ACCOUNTING_EXCEPTION');const before=await snapshot(f);
    expect(await complete(id)).toBe('PROCESSED');expect(await snapshot(f)).toEqual(before);await balances(f,[0,5000,0,4850,0,300,150]);
  });
  it('rejects mutation of finalized item, batch and original posted settlement entries',async()=>{
    const f=await capture(),id=await candidate(f);await complete(id);const {batch}=await finalEvidence(id,10000,9700),before=await snapshot(f);
    await expect(database.sql`update public.settlement_items set finalized_merchant_release=1 where settlement_id=${id}`).rejects.toThrow();
    await expect(database.sql`update public.settlements set finalized_asset_transfer=1 where id=${id}`).rejects.toThrow();
    await expect(database.sql`update public.ledger_entries set debit=debit where transaction_id=${batch.accounting_journal_id}`).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });
  it('replay raises integrity conflict for additional mismatched business journal evidence',async()=>{
    const f=await capture(),id=await candidate(f);await complete(id);
    await database.transaction(tx=>ledger.post(tx,{merchantId:f.merchantId,businessType:'SETTLEMENT',businessId:id,currency:'EUR',description:'Deliberately inconsistent business evidence',
      lines:[{accountCode:'PLATFORM_CASH',merchantId:null,debit:1},{accountCode:'PSP_CLEARING',merchantId:null,credit:1}]}));
    await expect(complete(id)).rejects.toMatchObject({code:'ACCOUNTING_INTEGRITY_CONFLICT'});
  });
  it('rejects unsafe combined Number debit boundary before any financial effects',async()=>{
    const f=await capture(Number.MAX_SAFE_INTEGER,0),id=await candidate(f),before=await snapshot(f);
    await expect(complete(id)).rejects.toMatchObject({code:'LEDGER_AMOUNT_UNREPRESENTABLE'});expect(await snapshot(f)).toEqual(before);
  });
  it('accepts the exact Number boundary with independent zero liability release',async()=>{
    const f=await capture(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),id=await candidate(f);await complete(id);
    await finalEvidence(id,String(Number.MAX_SAFE_INTEGER),0);await balances(f,[0,String(Number.MAX_SAFE_INTEGER),0,0,0,String(Number.MAX_SAFE_INTEGER),0]);
  });
  it('unchanged 0000–0005 migrator preserves current finalized, refunded and pending legacy evidence',async()=>{
    const f=await capture(),id=await candidate(f);await complete(id);await refund(f,5000);
    const zero=await capture();await refund(zero,10000);await complete(await candidate(zero));
    const pending=await capture(),legacy=new SettlementsService(database,ledger,audit);await legacy.generate(pending.merchantId);
    const before=await Promise.all([snapshot(f),snapshot(zero),snapshot(pending)]);
    const client=postgres(process.env.DATABASE_URL!,{max:1});try{await migrate(drizzle(client),{migrationsFolder:resolve(__dirname,'../../drizzle')});}finally{await client.end();}
    expect(await Promise.all([snapshot(f),snapshot(zero),snapshot(pending)])).toEqual(before);
    const [row]=await database.sql`select count(*)::integer as count from drizzle.__drizzle_migrations`;expect(row.count).toBe(6);
    expect(await complete(id)).toBe('PROCESSED');
  });

  function signal(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
  async function barrier(promise:Promise<void>){let timer!:ReturnType<typeof setTimeout>;try{await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Barrier timeout')),5000);})]);}finally{clearTimeout(timer);}}
  // Hold the FIRST actual service transaction after its work, then observe the
  // second blocked on that backend. No fabricated pre-acquisition or sleeps as proof.
  async function ordered(first:()=>Promise<unknown>,second:()=>Promise<unknown>) {
    const held=signal(),release=signal();let owner=0;
    const original=database.transaction.bind(database);
    const spy=jest.spyOn(database,'transaction').mockImplementationOnce(work=>original(async tx=>{
      await tx`set local statement_timeout='10s'`;const [row]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`;owner=row.pid;
      const result=await work(tx);held.resolve();await barrier(release.promise);return result;
    }));
    const a=first().then(value=>({value}),error=>({error:error as Error}));let b:Promise<{value:unknown}|{error:Error}>|undefined,failure:unknown;
    try{await barrier(held.promise);spy.mockRestore();b=second().then(value=>({value}),error=>({error:error as Error}));
      let observed=false;const deadline=Date.now()+5000;
      while(Date.now()<deadline){const rows=await database.sql`select pid from pg_stat_activity where datname=current_database() and ${owner}=any(pg_blocking_pids(pid))`;
        if(rows.length){observed=true;break;}await new Promise(done=>setTimeout(done,10));}expect(observed).toBe(true);
    }catch(error){failure=error instanceof Error?error:new Error(String(error));}finally{release.resolve();spy.mockRestore();}
    const [one,two]=await Promise.all([a,b]);if(failure instanceof Error) throw failure;if('error' in one) throw one.error;if(two && 'error' in two) throw two.error;
    return {first:one.value,second:two?.value};
  }
  it.each(['settlement-first','refund-first'] as const)('controlled generate versus refund (%s)',async order=>{
    const f=await capture(),r=await request(f,5000),inbox=await evidence(f,'refund.succeeded',r,5000);
    const financial=()=>database.transaction(tx=>refunds.applySucceeded(tx,inbox));
    const result=order==='settlement-first'?await ordered(()=>generate(f),financial):await ordered(financial,()=>generate(f));
    const [id]=(order==='settlement-first'?result.first:result.second) as string[];expect(id).toBeDefined();await complete(id);
    const {batch}=await finalEvidence(id,5000,4850);expect(batch.estimated_asset_transfer).toBe(order==='settlement-first'?'10000':'5000');await balances(f,[0,5000,0,4850,0,300,150]);
  });
  it.each(['settlement-first','dispute-first'] as const)('controlled generate versus dispute open (%s)',async order=>{
    const f=await capture(),inbox=await evidence(f,'dispute.opened',`dp_${randomUUID()}`,5000),financial=()=>database.transaction(tx=>disputes.applyOpened(tx,inbox));
    const result=order==='settlement-first'?await ordered(()=>generate(f),financial):await ordered(financial,()=>generate(f));
    const [id]=(order==='settlement-first'?result.first:result.second) as string[];await complete(id);const {batch}=await finalEvidence(id,10000,4700,5000);
    expect(batch.estimated_merchant_release).toBe(order==='settlement-first'?'9700':'4700');await balances(f,[0,10000,0,4700,5000,300,0]);
  });
  it.each(['settlement-first','refund-first'] as const)('controlled complete versus refund success (%s)',async order=>{
    const f=await capture(),r=await request(f,5000),inbox=await evidence(f,'refund.succeeded',r,5000),id=await candidate(f),financial=()=>database.transaction(tx=>refunds.applySucceeded(tx,inbox));
    if(order==='settlement-first') await ordered(()=>complete(id),financial);else await ordered(financial,()=>complete(id));
    await balances(f,[0,5000,0,4850,0,300,150]);expect(await complete(id)).toBe('PROCESSED');
    const [batch]=await database.sql`select finalized_asset_transfer::text,finalized_merchant_release::text from public.settlements where id=${id}`;
    expect(batch).toEqual({finalized_asset_transfer:order==='settlement-first'?'10000':'5000',finalized_merchant_release:order==='settlement-first'?'9700':'4850'});
  });
  it.each(['settlement-first','dispute-first'] as const)('controlled complete versus dispute open (%s)',async order=>{
    const f=await capture(),inbox=await evidence(f,'dispute.opened',`dp_${randomUUID()}`,5000),id=await candidate(f),financial=()=>database.transaction(tx=>disputes.applyOpened(tx,inbox));
    if(order==='settlement-first') await ordered(()=>complete(id),financial);else await ordered(financial,()=>complete(id));
    await balances(f,[0,10000,0,4700,5000,300,0]);expect(await complete(id)).toBe('PROCESSED');
  });
  it.each(['MERCHANT_WON','MERCHANT_LOST'] as const)('controlled complete/close orders for %s preserve attribution',async outcome=>{
    for(const order of ['settlement-first','close-first']) {
      const f=await capture(),d=await open(f),id=await candidate(f),inbox=await evidence(f,'dispute.closed',d.provider,5000,outcome),financial=()=>database.transaction(tx=>disputes.applyClosed(tx,inbox));
      if(order==='settlement-first') await ordered(()=>complete(id),financial);else await ordered(financial,()=>complete(id));
      await balances(f,outcome==='MERCHANT_WON'?[0,10000,0,9700,0,300,0]:[0,5000,0,4700,0,300,0]);expect(await complete(id)).toBe('PROCESSED');
    }
  });
  it.each(['a-first','b-first'] as const)('controlled duplicate generation creates one owner, no phantom batch (%s)',async order=>{
    const f=await capture(),a=()=>generate(f),b=()=>generate(f);const result=order==='a-first'?await ordered(a,b):await ordered(b,a);
    expect(result.first).toHaveLength(1);expect(result.second).toEqual([]);const [id]=result.first as string[];await complete(id);await finalEvidence(id,10000,9700);
    expect(await database.sql`select id from public.settlements where merchant_id=${f.merchantId}`).toHaveLength(1);
  });
  it.each(['a-first','b-first'] as const)('controlled duplicate completion keeps one journal and audit (%s)',async order=>{
    const f=await capture(),id=await candidate(f),a=()=>complete(id),b=()=>complete(id);const result=order==='a-first'?await ordered(a,b):await ordered(b,a);
    expect(result).toEqual({first:'PROCESSED',second:'PROCESSED'});await finalEvidence(id,10000,9700);await balances(f,[0,10000,0,9700,0,300,0]);
  });
  it.each(['settlement-first','exception-first'] as const)('controlled completion versus durable exception creation (%s)',async order=>{
    const f=await capture(),id=await candidate(f),inbox=await evidence(f,'dispute.opened',`dp_${randomUUID()}`,10001),financial=()=>database.transaction(tx=>disputes.applyOpened(tx,inbox));
    if(order==='settlement-first') {await ordered(()=>complete(id),financial);await balances(f,[0,10000,0,9700,0,300,0]);}
    else {const result=await ordered(financial,()=>complete(id));expect(result.second).toBe('ACCOUNTING_EXCEPTION');await balances(f,[10000,0,9700,0,0,300,0]);}
    const [e]=await database.sql`select count(*)::integer as count from public.accounting_exceptions where merchant_id=${f.merchantId} and status='OPEN'`;expect(e.count).toBe(1);
  });
  it.each(['settlement-first','capture-first'] as const)('controlled generation versus actual capture replay (%s)',async order=>{
    const f=await capture();const event:ProviderEvent={id:`evt_${randomUUID()}`,type:'payment.capture_succeeded',externalType:'charge.captured',createdAt:new Date(0).toISOString(),
      data:{merchantId:f.merchantId,paymentId:f.paymentId,attemptId:f.attemptId,providerTransactionId:`pi_${f.paymentId}`,paymentIntentId:`pi_${f.paymentId}`,amount:f.gross,currency:'USD'}};
    const financial=()=>database.transaction(tx=>business.handle(tx,event));
    const result=order==='settlement-first'?await ordered(()=>generate(f),financial):await ordered(financial,()=>generate(f));
    const [id]=(order==='settlement-first'?result.first:result.second) as string[];await complete(id);await finalEvidence(id,10000,9700);await balances(f,[0,10000,0,9700,0,300,0]);
    expect(await database.sql`select id from public.capture_accounting_lots where payment_id=${f.paymentId}`).toHaveLength(1);
  });
  it.each(['settlement-first','payout-first'] as const)('controlled completion versus payout reserves only existing available claim (%s)',async order=>{
    const a=await capture(4000,120),first=await candidate(a);await complete(first);const b=await capture(6000,180,a),id=await candidate(b);
    const financial=()=>payouts.request(actor(a),randomUUID(),{amount:2000,currency:'USD',destinationToken:'bank_test'});
    if(order==='settlement-first') await ordered(()=>complete(id),financial);else await ordered(financial,()=>complete(id));
    await finalEvidence(id,6000,5820);await balances(a,[0,10000,0,7700,0,300,0,2000]);
  });
});
