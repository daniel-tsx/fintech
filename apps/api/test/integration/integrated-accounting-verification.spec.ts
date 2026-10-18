import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DatabaseService } from '../../src/database/database.service';
import { CaptureDisputeAccountingService } from '../../src/disputes/capture-dispute-accounting.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { InternalOutboxProcessorService } from '../../src/outbox/internal-outbox-processor.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { PaymentsService } from '../../src/payments/payments.service';
import { PayoutsService } from '../../src/payouts/payouts.service';
import { CaptureRefundAccountingService } from '../../src/refunds/capture-refund-accounting.service';
import { RefundsService } from '../../src/refunds/refunds.service';
import { CaptureSettlementAccountingService } from '../../src/settlements/capture-settlement-accounting.service';
import { WebhookBusinessService } from '../../src/webhooks/webhook-business.service';
import type { ProviderEvent } from '../../src/webhooks/webhook.types';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Scope = { merchantId:string; currency:string };
type Capture = Scope & { paymentId:string; attemptId:string; lotId:string; journalId:string; providerId:string; amount:number };
// Only test admission is overridden. No production module/dispatcher is changed.
function admit(status:string) { if (!['FOUNDATION_ONLY','REVIEW_REQUIRED'].includes(status)) throw new Error('Missing dormant fixture'); }
class DormantRefund extends CaptureRefundAccountingService { protected assertActiveScope(status:string) { admit(status); } }
class DormantDispute extends CaptureDisputeAccountingService { protected assertActiveScope(status:string) { admit(status); } }
class DormantSettlement extends CaptureSettlementAccountingService { protected assertActiveScope(status:string) { admit(status); } }

describeDatabase('B3.1 integrated financial evidence (test admission, not runtime cutover)',()=>{
  let db:DatabaseService,ledger:LedgerService,audit:AuditService,business:WebhookBusinessService,payments:PaymentsService;
  let refunds:DormantRefund,disputes:DormantDispute,settlements:DormantSettlement,payouts:PayoutsService;
  beforeAll(()=>{
    db=new DatabaseService(new ConfigService({DATABASE_URL:process.env.DATABASE_URL}));ledger=new LedgerService(db);audit=new AuditService();
    const idem=new IdempotencyService(db),outbox=new OutboxService();
    business=new WebhookBusinessService(ledger,outbox,audit,new RefundsService(db,idem,outbox,audit,ledger),new DisputesService(ledger,audit));
    payments=new PaymentsService(db,idem,outbox,audit);refunds=new DormantRefund(db,idem,outbox,audit,ledger);
    disputes=new DormantDispute(ledger,audit);settlements=new DormantSettlement(db,ledger,audit);payouts=new PayoutsService(db,idem,ledger,outbox,audit);
  });
  afterAll(async()=>{try {
    expect((await db.sql`select count(*)::integer as count from public.capture_accounting_scopes where status='ACTIVE'`)[0].count).toBe(0);
    expect((await db.sql`select count(*)::integer as count from drizzle.__drizzle_migrations`)[0].count).toBe(8);
  } finally {await db.onApplicationShutdown();}});
  const actor=(f:Scope)=>({id:randomUUID(),type:'API_KEY' as const,role:'MERCHANT_ADMIN' as const,merchantId:f.merchantId});
  async function merchant() {
    const id=randomUUID();await db.sql`insert into public.merchants (id,name,fee_bps,settlement_delay_days) values (${id},'B3.1 isolated verification',300,0)`;return id;
  }
  // Authorization/provider confirmation are fixtures. The actual capture API,
  // business handler, journal, lot and audit execute without synthetic financial rows.
  async function capture(amount=10000,options:{merchantId?:string;currency?:string;authorized?:number;previous?:Capture}={}):Promise<Capture> {
    const previous=options.previous,merchantId=previous?.merchantId??options.merchantId??await merchant(),currency=previous?.currency??options.currency??'USD';
    const paymentId=previous?.paymentId??randomUUID(),providerId=previous?.providerId??`pi_${paymentId}`;
    if(!previous) {
      const authorized=options.authorized??amount;
      await db.sql`insert into public.payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,payment_method_token)
        values (${paymentId},${merchantId},'AUTHORIZED','MANUAL',${currency},${authorized},${authorized},'pm_test')`;
      await db.sql`insert into public.payment_attempts (merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id)
        values (${merchantId},${paymentId},'AUTHORIZE','SUCCEEDED',${authorized},${currency},${providerId})`;
    }
    const request=await payments.capture(actor({merchantId,currency}),paymentId,randomUUID(),{amount});
    const attemptId=request.value.captureAttemptId as string;
    const f={merchantId,currency,paymentId,providerId,attemptId,amount};
    await applyCapture(f);
    const [lot]=await db.sql<{id:string;capture_journal_id:string}[]>`select id,capture_journal_id from public.capture_accounting_lots where capture_attempt_id=${attemptId}`;
    return {...f,lotId:lot.id,journalId:lot.capture_journal_id};
  }
  async function inbox(event:ProviderEvent,status='IGNORED') {
    const [row]=await db.sql<{id:string}[]>`insert into public.webhook_events (provider,provider_event_id,event_type,signature,payload,status)
      values ('STRIPE',${event.id},${event.type},'verified-isolated-fixture',${db.sql.json(event as never)},${status}) returning id`;return row.id;
  }
  function captureEvent(f:Omit<Capture,'lotId'|'journalId'>):ProviderEvent {
    return {id:`evt_${randomUUID()}`,type:'payment.capture_succeeded',externalType:'charge.captured',createdAt:new Date(0).toISOString(),
      data:{merchantId:f.merchantId,paymentId:f.paymentId,attemptId:f.attemptId,providerTransactionId:f.providerId,paymentIntentId:f.providerId,amount:f.amount,currency:f.currency}};
  }
  async function applyCapture(f:Omit<Capture,'lotId'|'journalId'>) {
    const event=captureEvent(f),id=await inbox(event);
    // Same business transaction boundary as processor; signature/claim fixtures are explicit.
    await db.transaction(async tx=>{await tx`select id from public.webhook_events where id=${id} for update`;await business.handle(tx,event);
      await tx`update public.webhook_events set status='PROCESSED',processed_at=now() where id=${id}`;});return id;
  }
  async function evidence(f:Capture,type:'refund.succeeded'|'refund.failed'|'dispute.opened'|'dispute.closed',reference:string,amount:number,
    outcome?:'MERCHANT_WON'|'MERCHANT_LOST',status='IGNORED',identity?:string) {
    return inbox({id:`evt_${randomUUID()}`,type,externalType:type,createdAt:new Date(0).toISOString(),data:{merchantId:f.merchantId,paymentId:f.paymentId,
      providerTransactionId:type.startsWith('refund.')?`re_${reference}`:reference,paymentIntentId:identity??f.providerId,amount,currency:f.currency,
      ...(type.startsWith('refund.')?{refundId:reference}:{providerDisputeId:reference,outcome})}},status);
  }
  async function reserve(f:Capture,amount:number) {return (await refunds.create(actor(f),f.paymentId,randomUUID(),{amount})).value.id;}
  async function refund(f:Capture,amount:number) {
    const id=await reserve(f,amount),event=await evidence(f,'refund.succeeded',id,amount);
    expect(await db.transaction(tx=>refunds.applySucceeded(tx,event))).toBe('PROCESSED');return {id,event};
  }
  async function open(f:Capture,amount:number) {
    const reference=`dp_${randomUUID()}`,event=await evidence(f,'dispute.opened',reference,amount);
    expect(await db.transaction(tx=>disputes.applyOpened(tx,event))).toBe('PROCESSED');return {reference,amount,event};
  }
  async function close(f:Capture,d:{reference:string;amount:number},outcome:'MERCHANT_WON'|'MERCHANT_LOST') {
    const event=await evidence(f,'dispute.closed',d.reference,d.amount,outcome);
    expect(await db.transaction(tx=>disputes.applyClosed(tx,event))).toBe('PROCESSED');return event;
  }
  async function generate(f:Scope) {const ids=await settlements.generate(f.merchantId,f.currency);expect(ids).toHaveLength(1);return ids[0];}
  const complete=(id:string)=>db.transaction(tx=>settlements.complete(tx,id));
  async function settle(f:Scope) {const id=await generate(f);expect(await complete(id)).toBe('PROCESSED');return id;}
  async function payout(f:Scope,amount:number,finish=true) {
    const result=await payouts.request(actor(f),randomUUID(),{amount,currency:f.currency,destinationToken:'bank_isolated'}),id=result.value.id as string;
    if(finish) await db.transaction(tx=>payouts.complete(tx,id));return id;
  }
  // Independent constant oracles, never the production allocation helper. Asset/
  // expense balances are debit-normal; liability/revenue balances credit-normal.
  // Filter BOTH journal merchant and currency, including pooled platform accounts.
  const codes=['PSP_CLEARING','PLATFORM_CASH','MERCHANT_PENDING','MERCHANT_AVAILABLE','PAYOUT_CLEARING','DISPUTE_CLEARING','PLATFORM_FEE_REVENUE','PLATFORM_FEE_REFUNDS'];
  async function balances(f:Scope,expected:number[]) {
    expect(expected).toHaveLength(8);
    const rows=await db.sql<{code:string;balance:string}[]>`select a.code,
      sum(case when a.account_type in ('ASSET','EXPENSE') then e.debit-e.credit else e.credit-e.debit end)::text as balance
      from public.ledger_transactions t join public.ledger_entries e on e.transaction_id=t.id join public.ledger_accounts a on a.id=e.account_id
      where t.merchant_id=${f.merchantId} and t.currency=${f.currency} and t.status='POSTED' group by a.code`;
    const actual=Object.fromEntries(rows.map(r=>[r.code,BigInt(r.balance)]));expect(codes.map(c=>actual[c]??0n)).toEqual(expected.map(BigInt));
    const [ownership]=await db.sql<{valid:boolean}[]>`select coalesce(bool_and(a.currency=t.currency and
      (case when a.code in ('MERCHANT_PENDING','MERCHANT_AVAILABLE','PAYOUT_CLEARING','DISPUTE_CLEARING') then a.merchant_id=t.merchant_id else a.merchant_id is null end)),true) as valid
      from public.ledger_transactions t join public.ledger_entries e on e.transaction_id=t.id join public.ledger_accounts a on a.id=e.account_id
      where t.merchant_id=${f.merchantId} and t.currency=${f.currency}`;expect(ownership.valid).toBe(true);
    await durable(f);
  }
  async function durable(f:Scope) {
    const lots=await db.sql`select l.id,l.origin,l.original_gross::text,l.original_fee::text,l.original_net::text,l.settlement_state,
      v.original_valid,(v.journal_id,v.gross,v.fee,v.net,v.financial_captured_at)=(l.capture_journal_id,l.original_gross,l.original_fee,l.original_net,l.financial_captured_at) as matches,
      l.eligible_at=l.financial_captured_at as zero_delay from public.capture_accounting_lots l
      join public.capture_accounting_legacy_inventory v on v.capture_attempt_id=l.capture_attempt_id where l.merchant_id=${f.merchantId} and l.currency=${f.currency}`;
    expect(lots.length).toBeGreaterThan(0);for(const lot of lots) {expect(lot).toMatchObject({origin:'NEW_CAPTURE',original_valid:true,matches:true,zero_delay:true});
      expect(BigInt(lot.original_gross as string)-BigInt(lot.original_fee as string)).toBe(BigInt(lot.original_net as string));}
    const allocations=await db.sql`select r.refund_id,r.status,r.reserved_gross::text,r.confirmed_gross::text,r.confirmed_fee::text,r.journal_id,t.business_type,t.business_id,t.status as journal_status,
      l.original_gross::text,l.original_fee::text from public.refund_capture_allocations r join public.capture_accounting_lots l on l.id=r.capture_lot_id
      left join public.ledger_transactions t on t.id=r.journal_id where r.merchant_id=${f.merchantId} and r.currency=${f.currency}`;
    for(const a of allocations.filter(a=>a.status==='CONFIRMED')) {expect(a.confirmed_gross).toBe(a.reserved_gross);expect(a.journal_id).not.toBeNull();
      expect(a).toMatchObject({business_type:'REFUND',journal_status:'POSTED'});expect(a.business_id).toBe(a.refund_id);}
    const fees=await db.sql`select l.id,l.original_gross::text,l.original_fee::text,coalesce(sum(r.confirmed_gross),0)::text as gross,coalesce(sum(r.confirmed_fee),0)::text as fee
      from public.capture_accounting_lots l left join public.refund_capture_allocations r on r.capture_lot_id=l.id and r.status='CONFIRMED'
      where l.merchant_id=${f.merchantId} and l.currency=${f.currency} group by l.id`;
    for(const r of fees) expect(BigInt(r.fee as string)).toBe(BigInt(r.original_fee as string)*BigInt(r.gross as string)/BigInt(r.original_gross as string));
    const [finals]=await db.sql<{valid:boolean}[]>`select coalesce(bool_and(l.settlement_state='FINALIZED' and l.finalized_settlement_item_id=i.id
      and s.status='SUCCEEDED' and i.finalization_result is not null and i.accounting_finalized_at is not null
      and (i.gross_amount,i.fee_amount,i.net_amount)=(l.original_gross,l.original_fee,l.original_net)
      and (i.accounting_journal_id is null or (t.status='POSTED' and t.business_type='SETTLEMENT' and t.business_id=s.id))),true) as valid
      from public.settlement_items i join public.capture_accounting_lots l on l.id=i.capture_lot_id join public.settlements s on s.id=i.settlement_id
      left join public.ledger_transactions t on t.id=i.accounting_journal_id where s.merchant_id=${f.merchantId} and s.currency=${f.currency} and s.status='SUCCEEDED'`;
    expect(finals.valid).toBe(true);
    const batches=await db.sql`select s.finalized_asset_transfer::text,s.finalized_merchant_release::text,
      (select sum(finalized_asset_transfer)::text from public.settlement_items where settlement_id=s.id) as assets,
      (select sum(finalized_merchant_release)::text from public.settlement_items where settlement_id=s.id) as releases,
      (select count(*)::integer from public.audit_logs where target_id=s.id::text and action='settlement.completed') as audits
      from public.settlements s where merchant_id=${f.merchantId} and currency=${f.currency} and status='SUCCEEDED' and accounting_policy_version='CAPTURE_FIFO_V1'`;
    for(const b of batches) {expect(b.finalized_asset_transfer).toBe(b.assets);expect(b.finalized_merchant_release).toBe(b.releases);expect(b.audits).toBe(1);}
  }
  async function final(id:string,asset:number,release:number,held=0) {
    const [row]=await db.sql`select status,finalization_result,finalized_asset_transfer::text,finalized_merchant_release::text,
      (select sum(restricted_hold)::text from public.settlement_items where settlement_id=s.id) as held from public.settlements s where id=${id}`;
    expect(row).toEqual({status:'SUCCEEDED',finalization_result:asset||release?'POSTED':'ZERO_EFFECT',finalized_asset_transfer:String(asset),finalized_merchant_release:String(release),held:String(held)});
  }
  async function snapshot(f:Scope) {
    const [row]=await db.sql`select
      (select jsonb_agg(to_jsonb(p) order by id) from public.payments p where merchant_id=${f.merchantId} and currency=${f.currency}) as payments,
      (select jsonb_agg(to_jsonb(a) order by id) from public.payment_attempts a where merchant_id=${f.merchantId} and currency=${f.currency}) as attempts,
      (select jsonb_agg(to_jsonb(l) order by id) from public.capture_accounting_lots l where merchant_id=${f.merchantId} and currency=${f.currency}) as lots,
      (select jsonb_agg(to_jsonb(r) order by id) from public.refund_capture_allocations r where merchant_id=${f.merchantId} and currency=${f.currency}) as refunds,
      (select jsonb_agg(to_jsonb(r) order by id) from public.dispute_capture_allocations r where merchant_id=${f.merchantId} and currency=${f.currency}) as disputes,
      (select jsonb_agg(to_jsonb(t) order by id) from public.ledger_transactions t where merchant_id=${f.merchantId} and currency=${f.currency}) as journals,
      (select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_entries e join public.ledger_transactions t on t.id=e.transaction_id where t.merchant_id=${f.merchantId} and t.currency=${f.currency}) as entries,
      (select jsonb_agg(to_jsonb(a) order by id) from public.audit_logs a where merchant_id=${f.merchantId}) as audits`;return row;
  }

  it('L01: actual capture → settlement → completed payout conserves all eight accounts',async()=>{
    const f=await capture(),s=await settle(f);await final(s,10000,9700);await payout(f,9700);await balances(f,[0,300,0,0,0,0,300,0]);
  });
  it('L02: partial refund → settlement → payout uses returned fees and surviving asset',async()=>{
    const f=await capture();await refund(f,5000);await final(await settle(f),5000,4850);await payout(f,4850);await balances(f,[0,150,0,0,0,0,300,150]);
  });
  it('L03: full refund produces a zero-effect finalization without a settlement journal',async()=>{
    const f=await capture();await refund(f,10000);const s=await settle(f);await final(s,0,0);await balances(f,[0,0,0,0,0,0,300,300]);
  });
  it.each(['MERCHANT_WON','MERCHANT_LOST'] as const)('L04/L05: dispute → settlement → %s',async outcome=>{
    const f=await capture(),d=await open(f,5000);await final(await settle(f),10000,4700,5000);await close(f,d,outcome);
    await balances(f,outcome==='MERCHANT_WON'?[0,10000,0,9700,0,0,300,0]:[0,5000,0,4700,0,0,300,0]);
  });
  it('L06: settled and paid capture retains explained negative available after refund',async()=>{
    const f=await capture();await settle(f);await payout(f,9700);await refund(f,5000);await balances(f,[0,-4700,0,-4850,0,0,300,150]);
    await expect(payout(f,1)).rejects.toMatchObject({code:'INSUFFICIENT_AVAILABLE_BALANCE'});
  });
  it('L07: fractional cumulative fee reversals telescope exactly across three refunds',async()=>{
    const f=await capture(101);await refund(f,33);await refund(f,33);await refund(f,35);await final(await settle(f),0,0);await balances(f,[0,0,0,0,0,0,3,3]);
    const rows=await db.sql<{confirmed_fee:string}[]>`select confirmed_fee::text from public.refund_capture_allocations where payment_id=${f.paymentId} order by created_at,id`;
    expect(rows.map(r=>r.confirmed_fee)).toEqual(['0','1','2']);
  });
  it('L08: actual repeated capture → frozen FIFO refund across cash and PSP → mixed settlement',async()=>{
    const a=await capture(4000,{authorized:10000}),first=await settle(a),saved=await db.sql`select * from public.settlement_items where settlement_id=${first}`;
    const b=await capture(6000,{previous:a});await refund(b,5000);await final(await settle(b),5000,4850);await balances(a,[0,5000,0,4850,0,0,300,150]);
    expect(await db.sql`select * from public.settlement_items where settlement_id=${first}`).toEqual(saved);
    expect(await db.sql`select capture_lot_id,confirmed_gross::text,confirmed_fee::text from public.refund_capture_allocations where payment_id=${a.paymentId} order by confirmed_gross desc`)
      .toEqual([{capture_lot_id:a.lotId,confirmed_gross:'4000',confirmed_fee:'120'},{capture_lot_id:b.lotId,confirmed_gross:'1000',confirmed_fee:'30'}]);
  });
  it('L09: two funded holds, one loss, immutable reduction and remaining win conserve entitlement',async()=>{
    const f=await capture(),a=await open(f,5000),b=await open(f,5000);await close(f,a,'MERCHANT_LOST');
    await final(await settle(f),5000,0,4700);await close(f,b,'MERCHANT_WON');await balances(f,[0,5000,0,4700,0,0,300,0]);
    const effects=await db.sql`select h.hold_delta::text,t.status,t.business_type from public.dispute_hold_effects h join public.ledger_transactions t on t.id=h.journal_id where h.payment_id=${f.paymentId}`;
    expect(effects).toEqual([]); // Already restricted to the surviving 4700; no unnecessary effect.
  });
  it.each(['refund-first','dispute-first'] as const)('L10: disjoint refund and dispute confirmations (%s)',async order=>{
    const f=await capture(),r=await reserve(f,4000),event=await evidence(f,'refund.succeeded',r,4000);let d:Awaited<ReturnType<typeof open>>;
    if(order==='refund-first') {await db.transaction(tx=>refunds.applySucceeded(tx,event));d=await open(f,6000);} else {d=await open(f,6000);await db.transaction(tx=>refunds.applySucceeded(tx,event));}
    await final(await settle(f),6000,0,5820);await close(f,d,'MERCHANT_LOST');await balances(f,[0,0,0,-180,0,0,300,120]);
    const effects=await db.sql<{hold_delta:string}[]>`select hold_delta::text from public.dispute_hold_effects where payment_id=${f.paymentId}`;
    expect(effects.map(r=>r.hold_delta)).toEqual(order==='dispute-first'?['-180']:[]);
  });
  it.each(['refund-first','dispute-first'] as const)('L11/L12: generate → both confirmed adjustments → complete (%s)',async order=>{
    const f=await capture(),s=await generate(f),r=await reserve(f,4000),event=await evidence(f,'refund.succeeded',r,4000);
    if(order==='refund-first') {await db.transaction(tx=>refunds.applySucceeded(tx,event));await open(f,6000);} else {await open(f,6000);await db.transaction(tx=>refunds.applySucceeded(tx,event));}
    await complete(s);await final(s,6000,0,5820);await balances(f,[0,6000,0,0,0,5820,300,120]);
  });
  it('L13: completion → dispute close → payout releases only the surviving unencumbered funds',async()=>{
    const f=await capture(),d=await open(f,5000);await settle(f);await close(f,d,'MERCHANT_LOST');await payout(f,4700);await balances(f,[0,300,0,0,0,0,300,0]);
  });
  it('L14: two payments in one scope reconcile refunds and holds without consuming another pending entitlement',async()=>{
    const a=await capture(),b=await capture(10000,{merchantId:a.merchantId});await refund(a,5000);const d=await open(b,5000);
    await final(await settle(a),15000,9550,5000);await close(b,d,'MERCHANT_LOST');await payout(a,9550);await balances(a,[0,450,0,0,0,0,600,150]);
    const [item]=await db.sql`select finalized_merchant_release::text from public.settlement_items where capture_lot_id=${a.lotId}`;expect(item.finalized_merchant_release).toBe('4850');
  });
  it('L15: two merchants share only platform accounts; one merchant debt cannot spend the other liability',async()=>{
    const a=await capture(),b=await capture();await settle(a);await settle(b);await payout(a,9700);await refund(a,5000);
    await balances(a,[0,-4700,0,-4850,0,0,300,150]);await balances(b,[0,10000,0,9700,0,0,300,0]);
    await expect(payout(a,1)).rejects.toMatchObject({code:'INSUFFICIENT_AVAILABLE_BALANCE'});await payout(b,9700);await balances(b,[0,300,0,0,0,0,300,0]);
    const [shared]=await db.sql`select count(distinct e.account_id)::integer as count from public.ledger_entries e join public.ledger_transactions t on t.id=e.transaction_id
      join public.ledger_accounts a on a.id=e.account_id where t.merchant_id in (${a.merchantId},${b.merchantId}) and a.code='PLATFORM_CASH'`;expect(shared.count).toBe(1);
  });
  it('L16: same merchant USD debt and EUR availability remain currency-isolated',async()=>{
    const usd=await capture(),eur=await capture(10000,{merchantId:usd.merchantId,currency:'EUR'});await settle(usd);await settle(eur);
    await payout(usd,9700);await refund(usd,5000);await payout(eur,9700);
    await balances(usd,[0,-4700,0,-4850,0,0,300,150]);await balances(eur,[0,300,0,0,0,0,300,0]);
  });
  it.each([
    ['MERCHANT_WON','before'],['MERCHANT_WON','after'],['MERCHANT_LOST','before'],['MERCHANT_LOST','after'],
  ] as const)('L17: mixed settled/unsettled capture dispute %s closes %s remaining settlement',async(outcome,phase)=>{
    const a=await capture(4000,{authorized:10000});await settle(a);const b=await capture(6000,{previous:a}),d=await open(b,5000);
    await balances(a,[6000,4000,4820,0,0,4880,300,0]);
    expect(await db.sql`select capture_lot_id,gross_principal::text,funded_hold::text from public.dispute_capture_allocations
      where payment_id=${a.paymentId} order by gross_principal desc`).toEqual([
      {capture_lot_id:a.lotId,gross_principal:'4000',funded_hold:'3880'},{capture_lot_id:b.lotId,gross_principal:'1000',funded_hold:'1000'},
    ]);
    if(phase==='before') await close(b,d,outcome);await settle(b);if(phase==='after') await close(b,d,outcome);
    await balances(a,outcome==='MERCHANT_WON'?[0,10000,0,9700,0,0,300,0]:[0,5000,0,4700,0,0,300,0]);
  });
  it('L18: disjoint loss plus refund finalizes zero assets while retaining fee-related merchant debt',async()=>{
    const f=await capture(),d=await open(f,5000);await close(f,d,'MERCHANT_LOST');await refund(f,5000);
    await final(await settle(f),0,0);await balances(f,[0,0,0,-150,0,0,300,150]);
  });
  it('L19: loss of the later hold reduces the earlier hold through one referenced immutable journal',async()=>{
    const f=await capture(),a=await open(f,5000),b=await open(f,5000);await close(f,b,'MERCHANT_LOST');
    const [effect]=await db.sql<{id:string;hold_delta:string;journal_id:string}[]>`select id,hold_delta::text,journal_id from public.dispute_hold_effects where payment_id=${f.paymentId}`;
    expect(effect.hold_delta).toBe('-300');await final(await settle(f),5000,0,4700);await close(f,a,'MERCHANT_WON');await balances(f,[0,5000,0,4700,0,0,300,0]);
    await expect(db.sql`update public.dispute_hold_effects set hold_delta=-1 where id=${effect.id}`).rejects.toThrow();
    expect((await db.sql`select hold_delta::text from public.dispute_hold_effects where id=${effect.id}`)[0].hold_delta).toBe('-300');
    expect(await db.sql`select status,business_type from public.ledger_transactions where id=${effect.journal_id}`).toEqual([{status:'POSTED',business_type:'DISPUTE_HOLD_ADJUSTMENT'}]);
  });

  function signal(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
  async function bounded<T>(promise:Promise<T>):Promise<T> {let timer!:ReturnType<typeof setTimeout>;
    try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Transaction barrier timeout')),7000);})]);}finally{clearTimeout(timer);}}
  // Identify BOTH backends. Gates hold actual service work before commit; no
  // fabricated financial lock, no retry and no sleeps used as blocking evidence.
  async function ordered(first:()=>Promise<unknown>,second:()=>Promise<unknown>) {
    const held=signal(),release=signal(),started=signal();let firstPid=0,secondPid=0;
    const original=db.transaction.bind(db);
    const spy=jest.spyOn(db,'transaction');
    spy.mockImplementationOnce(work=>original(async tx=>{await tx`set local statement_timeout='12s'`;const [r]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`;
      firstPid=r.pid;const result=await work(tx);held.resolve();await bounded(release.promise);return result;}));
    const a=first().then(value=>({value}),error=>({error:error as Error}));let b:Promise<{value:unknown}|{error:Error}>|undefined,observed=false;
    try {await bounded(held.promise);
      spy.mockImplementationOnce(work=>original(async tx=>{await tx`set local statement_timeout='12s'`;const [r]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`;
        secondPid=r.pid;started.resolve();return work(tx);}));
      b=second().then(value=>({value}),error=>({error:error as Error}));await bounded(started.promise);
      const deadline=Date.now()+5000;while(Date.now()<deadline) {const [r]=await db.sql<{blocked:boolean}[]>`select ${firstPid}=any(pg_blocking_pids(${secondPid})) as blocked`;
        if(r.blocked){observed=true;break;}await new Promise(done=>setTimeout(done,10));}
    } finally {release.resolve();spy.mockRestore();await Promise.all([a,b]);}
    expect(firstPid).not.toBe(secondPid);expect(observed).toBe(true);return {first:await a,second:await b};
  }
  function success(result:{value?:unknown;error?:Error}|undefined) {if(!result) throw new Error('Missing operation');if(result.error) throw result.error;return result.value;}
  it.each(['refund-first','payout-first'] as const)('C01: different-payment refund success versus pooled payout (%s)',async order=>{
    const a=await capture(),b=await capture(10000,{merchantId:a.merchantId});await settle(a);
    const r=await reserve(a,5000),event=await evidence(a,'refund.succeeded',r,5000),apply=()=>db.transaction(tx=>refunds.applySucceeded(tx,event)),pay=()=>payout(b,15000,false);
    const result=order==='refund-first'?await ordered(apply,pay):await ordered(pay,apply);success(result.first);
    if(order==='refund-first') {expect(result.second).toMatchObject({error:{code:'INSUFFICIENT_AVAILABLE_BALANCE'}});await balances(a,[0,15000,0,14550,0,0,600,150]);}
    else {success(result.second);await balances(a,[0,15000,0,-450,15000,0,600,150]);}
  });
  it.each(['dispute-first','payout-first'] as const)('C02: different-payment dispute hold versus pooled payout (%s)',async order=>{
    const a=await capture(),b=await capture(10000,{merchantId:a.merchantId});await settle(a);
    const event=await evidence(a,'dispute.opened',`dp_${randomUUID()}`,5000),apply=()=>db.transaction(tx=>disputes.applyOpened(tx,event)),pay=()=>payout(b,15000,false);
    const result=order==='dispute-first'?await ordered(apply,pay):await ordered(pay,apply);success(result.first);
    if(order==='dispute-first') {expect(result.second).toMatchObject({error:{code:'INSUFFICIENT_AVAILABLE_BALANCE'}});await balances(a,[0,20000,0,14400,0,5000,600,0]);}
    else {success(result.second);await balances(a,[0,20000,0,-600,15000,5000,600,0]);}
  });
  it.each(['refund-first','close-first'] as const)('C03: concurrent hold reductions on the same lot (%s)',async order=>{
    const f=await capture(),r=await reserve(f,4000),a=await open(f,3000),b=await open(f,3000),s=await generate(f);
    const re=await evidence(f,'refund.succeeded',r,4000),ce=await evidence(f,'dispute.closed',a.reference,3000,'MERCHANT_LOST');
    const ra=()=>db.transaction(tx=>refunds.applySucceeded(tx,re)),ca=()=>db.transaction(tx=>disputes.applyClosed(tx,ce));
    const result=order==='refund-first'?await ordered(ra,ca):await ordered(ca,ra);success(result.first);success(result.second);
    await complete(s);await final(s,3000,0,2820);await close(f,b,'MERCHANT_WON');await balances(f,[0,3000,0,2820,0,0,300,120]);
    const effects=await db.sql<{hold_delta:string;journal_id:string}[]>`select hold_delta::text,journal_id from public.dispute_hold_effects where payment_id=${f.paymentId}`;
    expect(effects.map(r=>r.hold_delta)).toEqual(['-180']);expect(effects[0].journal_id).not.toBeNull();
  });
  it.each(['a-first','b-first'] as const)('C04: frozen concurrent refunds share capacity with exact cumulative fee (%s)',async order=>{
    const f=await capture(101),a=await reserve(f,33),b=await reserve(f,33),ae=await evidence(f,'refund.succeeded',a,33),be=await evidence(f,'refund.succeeded',b,33);
    const apply=(id:string)=>db.transaction(tx=>refunds.applySucceeded(tx,id));
    const result=order==='a-first'?await ordered(()=>apply(ae),()=>apply(be)):await ordered(()=>apply(be),()=>apply(ae));success(result.first);success(result.second);
    await refund(f,35);await settle(f);await balances(f,[0,0,0,0,0,0,3,3]);
  });
  it('C05: different merchant scopes wait on fresh shared platform account uniqueness without deadlock',async()=>{
    const [fresh]=await db.sql<{currency:string}[]>`select 'Q'||chr(a)||chr(b) as currency from generate_series(65,90) a cross join generate_series(65,90) b
      where not exists(select 1 from public.ledger_accounts where currency='Q'||chr(a)||chr(b)) order by a,b limit 1`;
    const currency=fresh.currency;
    // ISO shape only in these internal fixtures; no external provider currency claim.
    const a=await capture(10000,{currency}),b=await capture(10000,{currency}),as=await generate(a),bs=await generate(b);
    const result=await ordered(()=>complete(as),()=>complete(bs));success(result.first);success(result.second);
    await balances(a,[0,10000,0,9700,0,0,300,0]);await balances(b,[0,10000,0,9700,0,0,300,0]);
  });
  it('C06: different currencies commit independently while one actual completion is gated',async()=>{
    const a=await capture(),b=await capture(10000,{merchantId:a.merchantId,currency:'EUR'}),as=await generate(a),bs=await generate(b);
    const held=signal(),release=signal(),original=db.transaction.bind(db);
    const spy=jest.spyOn(db,'transaction').mockImplementationOnce(work=>original(async tx=>{const result=await work(tx);held.resolve();await bounded(release.promise);return result;}));
    const first=complete(as).then(value=>({value}),error=>({error:error as Error}));
    try{await bounded(held.promise);spy.mockRestore();expect(await bounded(complete(bs))).toBe('PROCESSED');}
    finally{release.resolve();spy.mockRestore();success(await first);}
    await balances(a,[0,10000,0,9700,0,0,300,0]);await balances(b,[0,10000,0,9700,0,0,300,0]);
  });

  it.each(['journal','allocation','deferred'] as const)('R01: integrated refund abort at %s boundary rolls back journal/allocation/audit/inbox then retries',async boundary=>{
    const f=await capture(),r=await reserve(f,5000),event=await evidence(f,'refund.succeeded',r,5000),before=await snapshot(f);
    let restore=()=>{},reached=false;
    if(boundary==='journal') {const original=ledger.post.bind(ledger),spy=jest.spyOn(ledger,'post').mockImplementationOnce(async(tx,posting)=>{
      await original(tx,posting);reached=true;throw new Error('Injected after journal');});restore=()=>spy.mockRestore();}
    if(boundary==='allocation') {const spy=jest.spyOn(audit,'append').mockImplementationOnce(async tx=>{
      expect(await tx`select status from public.refund_capture_allocations where refund_id=${r}`).toEqual([{status:'CONFIRMED'}]);
      reached=true;throw new Error('Injected after allocation');});restore=()=>spy.mockRestore();}
    try {const operation=db.transaction(async tx=>{await refunds.applySucceeded(tx,event);
      if(boundary==='deferred') {
        const [account]=await tx<{id:string}[]>`select id from public.ledger_accounts where code='PSP_CLEARING' and merchant_id is null and currency=${f.currency}`;
        const [draft]=await tx<{id:string}[]>`insert into public.ledger_transactions (merchant_id,business_type,business_id,currency,description)
          values (${f.merchantId},'B31_DEFERRED_FIXTURE',${randomUUID()},${f.currency},'Commit validation fixture') returning id`;
        await tx`insert into public.ledger_entries (transaction_id,account_id,currency,debit,credit) values (${draft.id},${account.id},${f.currency},1,0)`;
        await tx`update public.ledger_transactions set status='POSTED',posted_at=now() where id=${draft.id}`;
        reached=true; // Callback completed; rejection must come from commit validation.
      }
    });await expect(operation).rejects.toThrow(boundary==='deferred'?'not balanced':'Injected after');}finally{restore();}
    expect(reached).toBe(true);
    expect(await snapshot(f)).toEqual(before);expect((await db.sql`select status from public.webhook_events where id=${event}`)[0].status).toBe('IGNORED');
    expect(await db.transaction(tx=>refunds.applySucceeded(tx,event))).toBe('PROCESSED');await settle(f);await balances(f,[0,5000,0,4850,0,0,300,150]);
  });
  it('R02: accepted refund retains frozen attribution after a later actual capture',async()=>{
    const a=await capture(4000,{authorized:10000}),r=await reserve(a,2000);const b=await capture(6000,{previous:a});
    const event=await evidence(b,'refund.succeeded',r,2000);expect(await db.transaction(tx=>refunds.applySucceeded(tx,event))).toBe('PROCESSED');await settle(b);
    await balances(b,[0,8000,0,7760,0,0,300,60]);expect(await db.sql`select capture_lot_id,reserved_gross::text from public.refund_capture_allocations where refund_id=${r}`)
      .toEqual([{capture_lot_id:a.lotId,reserved_gross:'2000'}]);
  });
  it('R03: unknown refund outcome reserves capacity but invents no journal or financial application',async()=>{
    const f=await capture(),r=await reserve(f,10000);await expect(reserve(f,1)).rejects.toMatchObject({code:'REFUND_CAPACITY_UNAVAILABLE'});
    expect(await db.sql`select status,journal_id from public.refund_capture_allocations where refund_id=${r}`).toEqual([{status:'RESERVED',journal_id:null}]);
    await balances(f,[10000,0,9700,0,0,0,300,0]);
  });
  it('R04: duplicate committed events and lost settlement response replay preserve financial evidence',async()=>{
    const f=await capture(),r=await refund(f,5000),s=await settle(f),before=await snapshot(f);
    await applyCapture(f);
    expect(await db.transaction(tx=>refunds.applySucceeded(tx,r.event))).toBe('PROCESSED');expect(await complete(s)).toBe('PROCESSED');
    expect(await snapshot(f)).toEqual(before);await balances(f,[0,5000,0,4850,0,0,300,150]);
  });
  it('R05: contradictory refund failure preserves success and records exception, without reversing financial evidence',async()=>{
    const f=await capture(),r=await refund(f,5000),event=await evidence(f,'refund.failed',r.id,5000);
    expect(await db.transaction(tx=>refunds.applyFailed(tx,event))).toBe('ACCOUNTING_EXCEPTION');await balances(f,[5000,0,4850,0,0,0,300,150]);
    expect(await db.sql`select status from public.refunds where id=${r.id}`).toEqual([{status:'SUCCEEDED'}]);expect(await settlements.generate(f.merchantId,f.currency)).toEqual([]);
  });
  it('R06: trusted dispute close-before-open retries original evidence and later applies once',async()=>{
    const f=await capture(),reference=`dp_${randomUUID()}`,event=await evidence(f,'dispute.closed',reference,5000,'MERCHANT_WON'),before=await snapshot(f);
    await expect(db.transaction(tx=>disputes.applyClosed(tx,event))).rejects.toThrow();expect(await snapshot(f)).toEqual(before);
    const opened=await evidence(f,'dispute.opened',reference,5000);expect(await db.transaction(tx=>disputes.applyOpened(tx,opened))).toBe('PROCESSED');
    expect(await db.transaction(tx=>disputes.applyClosed(tx,event))).toBe('PROCESSED');await settle(f);await balances(f,[0,10000,0,9700,0,0,300,0]);
  });
  it('R07: actual internal worker retry after financial commit does not duplicate payout completion',async()=>{
    const f=await capture();await settle(f);const id=await payout(f,9700,false);
    const [work]=await db.sql<{id:string}[]>`select id from public.outbox_events where event_type='payout.process' and aggregate_id=${id}`;
    // Claim/financial commit succeeds, but worker disappears before PUBLISHED.
    await db.sql`update public.outbox_events set status='PROCESSING',locked_at=now()-interval '3 minutes',created_at='2000-01-01' where id=${work.id}`;
    await db.transaction(tx=>payouts.complete(tx,id));const before=await snapshot(f);
    const worker=new InternalOutboxProcessorService(db,payouts);expect(await worker.drain(1)).toBe(1);
    expect(await snapshot(f)).toEqual(before);expect(await db.sql`select status from public.outbox_events where id=${work.id}`).toEqual([{status:'PUBLISHED'}]);
    expect(await db.sql`select id from public.ledger_transactions where business_type='PAYOUT_COMPLETION' and business_id=${id}`).toHaveLength(1);await balances(f,[0,300,0,0,0,0,300,0]);
  });
  it('A01: records late receipt admission gap: confirmed PENDING evidence can commit while settlement is uncommitted',async()=>{
    const f=await capture(),r=await reserve(f,5000),s=await generate(f),held=signal(),release=signal();
    const work=db.transaction(async tx=>{const result=await settlements.complete(tx,s);held.resolve();await bounded(release.promise);return result;})
      .then(value=>({value}),error=>({error:error as Error}));let event='';
    try{await bounded(held.promise);event=await evidence(f,'refund.succeeded',r,5000,undefined,'PENDING');}
    finally{release.resolve();success(await work);}
    await final(s,10000,9700);expect(await db.sql`select status from public.webhook_events where id=${event}`).toEqual([{status:'PENDING'}]);
    await balances(f,[0,10000,0,9700,0,0,300,0]); // Incomplete provider view, not a claimed final reconciliation.
    expect(await db.transaction(tx=>refunds.applySucceeded(tx,event))).toBe('PROCESSED');await balances(f,[0,5000,0,4850,0,0,300,150]);
  });
  it('A02: review/exception is not payout quarantine in current runtime',async()=>{
    const f=await capture();await settle(f);const r=await reserve(f,5000),event=await evidence(f,'refund.succeeded',r,5000,undefined,'IGNORED',`pi_${randomUUID()}`);
    expect(await db.transaction(tx=>refunds.applySucceeded(tx,event))).toBe('ACCOUNTING_EXCEPTION');
    expect(await db.sql`select status from public.accounting_exceptions where merchant_id=${f.merchantId}`).toEqual([{status:'OPEN'}]);
    await payout(f,9700);await balances(f,[0,300,0,0,0,0,300,0]); // Explicit cutover gap, not authorization to activate.
  });
});
