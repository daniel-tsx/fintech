import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DatabaseService, type DbTransaction } from '../../src/database/database.service';
import { CaptureDisputeAccountingService } from '../../src/disputes/capture-dispute-accounting.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { PayoutsService } from '../../src/payouts/payouts.service';
import { CaptureRefundAccountingService } from '../../src/refunds/capture-refund-accounting.service';
import { RefundsService } from '../../src/refunds/refunds.service';
import { SettlementsService } from '../../src/settlements/settlements.service';
import { WebhookBusinessService } from '../../src/webhooks/webhook-business.service';
import { RetryableWebhookError, type ProviderEvent, type ProviderEventData } from '../../src/webhooks/webhook.types';
import { accountContributions, captureFixture } from '../support/accounting-fixtures';

const describeDatabase=process.env.RUN_DB_TESTS==='1'?describe:describe.skip;
type Capture=Awaited<ReturnType<typeof captureFixture>> & {lotId:string};
class DormantDispute extends CaptureDisputeAccountingService {
  protected assertActiveScope(status:string):void { if (!['FOUNDATION_ONLY','REVIEW_REQUIRED'].includes(status)) throw new Error('Missing dormant fixture scope'); }
}
class DormantRefund extends CaptureRefundAccountingService {
  protected assertActiveScope(status:string):void { if (!['FOUNDATION_ONLY','REVIEW_REQUIRED'].includes(status)) throw new Error('Missing dormant fixture scope'); }
}
describeDatabase('B2.3 dormant capture dispute transactions (not runtime dispatch)',()=>{
  let database:DatabaseService; let ledger:LedgerService; let service:DormantDispute; let refunds:DormantRefund;
  let payouts:PayoutsService; let audit:AuditService; let outbox:OutboxService; let business:WebhookBusinessService;
  beforeAll(()=>{
    database=new DatabaseService(new ConfigService({DATABASE_URL:process.env.DATABASE_URL})); ledger=new LedgerService(database);
    audit=new AuditService(); outbox=new OutboxService(); const idempotency=new IdempotencyService(database);
    service=new DormantDispute(ledger,audit); refunds=new DormantRefund(database,idempotency,outbox,audit,ledger);
    payouts=new PayoutsService(database,idempotency,ledger,outbox,audit);
    business=new WebhookBusinessService(ledger,outbox,audit,new RefundsService(database,idempotency,outbox,audit,ledger),new DisputesService(ledger,audit));
  });
  afterAll(async()=>{await database.onApplicationShutdown();});
  const actor=(f:Capture)=>({id:randomUUID(),type:'API_KEY' as const,role:'MERCHANT_ADMIN' as const,merchantId:f.merchantId});
  async function capture(gross=10000,fee=300,scope?:{merchantId:string;paymentId:string}):Promise<Capture> {
    const f=await captureFixture(database,gross,fee,scope);
    await database.sql`insert into public.capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD') on conflict do nothing`;
    const [lot]=await database.sql<{id:string}[]>`insert into public.capture_accounting_lots
      (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at)
      select ${f.attemptId},${f.paymentId},${f.merchantId},'USD',id,${gross},${fee},${gross-fee},posted_at,posted_at from public.ledger_transactions where id=${f.journalId} returning id`;
    return {...f,lotId:lot.id};
  }
  async function evidence(f:Capture,providerDisputeId:string,type:'dispute.opened'|'dispute.closed',amount:number,outcome?:'MERCHANT_WON'|'MERCHANT_LOST',changes:Partial<ProviderEventData>={}) {
    const event:ProviderEvent={id:`evt_${randomUUID()}`,type,externalType:type,createdAt:new Date(0).toISOString(),data:{
      merchantId:f.merchantId,paymentId:f.paymentId,providerDisputeId,providerTransactionId:providerDisputeId,paymentIntentId:`pi_${f.paymentId}`,amount,currency:'USD',outcome,...changes}};
    const [row]=await database.sql<{id:string}[]>`insert into public.webhook_events (provider,provider_event_id,event_type,signature,payload,status)
      values ('STRIPE',${event.id},${type},'isolated-fixture',${database.sql.json(event as never)},'IGNORED') returning id`;
    return row.id;
  }
  const apply=(id:string,close=false)=>database.transaction(tx=>close?service.applyClosed(tx,id):service.applyOpened(tx,id));
  async function open(f:Capture,amount=5000,provider=`dp_${randomUUID()}`) {
    const inboxId=await evidence(f,provider,'dispute.opened',amount); expect(await apply(inboxId)).toBe('PROCESSED');
    const [d]=await database.sql<{id:string}[]>`select id from public.disputes where provider_dispute_id=${provider}`;
    return {id:d.id,provider,amount,inboxId};
  }
  async function close(f:Capture,d:Awaited<ReturnType<typeof open>>,outcome:'MERCHANT_WON'|'MERCHANT_LOST') {
    const id=await evidence(f,d.provider,'dispute.closed',d.amount,outcome); expect(await apply(id,true)).toBe('PROCESSED'); return id;
  }
  async function balances(f:Capture,values:number[]) {
    const codes=['PSP_CLEARING','PLATFORM_CASH','MERCHANT_PENDING','MERCHANT_AVAILABLE','DISPUTE_CLEARING','PLATFORM_FEE_REVENUE','PLATFORM_FEE_REFUNDS'];
    const actual=await database.transaction(tx=>accountContributions(tx,f.merchantId));
    expect(codes.map(code=>actual[code]??'0')).toEqual(values.map(String));
  }
  async function allocation(d:string) {
    return database.sql<{id:string;capture_lot_id:string;gross:string;funded:string;unfunded:string;held:string;status:string;outcome:string|null}[]>`select a.id,capture_lot_id,gross_principal::text as gross,
      funded_hold::text as funded,unfunded_exposure::text as unfunded,(funded_hold+coalesce(e.delta,0))::text as held,status,outcome
      from public.dispute_capture_allocations a left join lateral (select sum(hold_delta) as delta from public.dispute_hold_effects where allocation_id=a.id) e on true
      where dispute_id=${d} order by capture_lot_id`;
  }
  async function lines(id:string,kind:string) {
    return database.sql`select a.code,sum(e.debit)::text as debit,sum(e.credit)::text as credit from public.ledger_transactions t
      join public.ledger_entries e on e.transaction_id=t.id join public.ledger_accounts a on a.id=e.account_id where t.business_id=${id} and t.business_type=${kind} group by a.code order by a.code`;
  }
  async function fingerprint(f:Capture) {
    const [row]=await database.sql`select (select jsonb_agg(to_jsonb(t) order by id) from public.ledger_transactions t where merchant_id=${f.merchantId}) as journals,
      (select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_entries e join public.ledger_transactions t on t.id=e.transaction_id where t.merchant_id=${f.merchantId}) as entries`;
    return row;
  }
  async function original(f:Capture) {
    const [row]=await database.sql`select to_jsonb(t) as journal,(select jsonb_agg(to_jsonb(e) order by id) from public.ledger_entries e where e.transaction_id=t.id) as entries from public.ledger_transactions t where id=${f.journalId}`;
    return row;
  }
  async function state(f:Capture,d:string,id:string) {
    const [row]=await database.sql`select p.status as payment_status,d.status,d.outcome,p.refunded_amount::text,
      (select status from public.webhook_events where id=${id}) as inbox_status,
      (select count(*)::integer from public.audit_logs where target_id=p.id::text and metadata->>'disputeId'=d.id::text) as audits
      from public.disputes d join public.payments p on p.id=d.payment_id where d.id=${d} and p.id=${f.paymentId}`;
    return row;
  }
  // Complete valid B1 evidence only; this is expressly not a B2.4 runtime writer.
  async function settle(f:Capture) {
    await database.transaction(async tx=>{
      const [l]=await tx<{allocation_revision:string;asset:string;release:string;held:string}[]>`select l.allocation_revision,
        (l.original_gross-coalesce(r.gross,0)-coalesce(d.lost,0))::text as asset,
        greatest(l.original_net-coalesce(r.gross,0)+coalesce(r.fee,0)-coalesce(d.lost,0)-coalesce(d.held,0),0)::text as release,coalesce(d.held,0)::text as held
        from public.capture_accounting_lots l left join lateral (select sum(confirmed_gross) as gross,sum(confirmed_fee) as fee from public.refund_capture_allocations where capture_lot_id=l.id and status='CONFIRMED') r on true
        left join lateral (select sum(gross_principal) filter(where status='CLOSED' and outcome='MERCHANT_LOST') as lost,
          sum(funded_hold+coalesce(e.delta,0)) filter(where status='OPEN') as held from public.dispute_capture_allocations a
          left join lateral (select sum(hold_delta) as delta from public.dispute_hold_effects where allocation_id=a.id) e on true where capture_lot_id=l.id) d on true where l.id=${f.lotId}`;
      const asset=Number(l.asset),release=Number(l.release),result=asset||release?'POSTED':'ZERO_EFFECT';
      const [s]=await tx<{id:string}[]>`insert into public.settlements (merchant_id,currency,gross_amount,fee_amount,net_amount,available_on,accounting_policy_version,estimated_asset_transfer,estimated_merchant_release)
        values (${f.merchantId},'USD',${f.gross},${f.fee},${f.gross-f.fee},now(),'CAPTURE_FIFO_V1',${asset},${release}) returning id`;
      const [i]=await tx<{id:string}[]>`insert into public.settlement_items (settlement_id,payment_id,capture_attempt_id,gross_amount,fee_amount,net_amount,currency,capture_lot_id,accounting_policy_version,estimated_asset_transfer,estimated_merchant_release,selected_revision)
        values (${s.id},${f.paymentId},${f.attemptId},${f.gross},${f.fee},${f.gross-f.fee},'USD',${f.lotId},'CAPTURE_FIFO_V1',${asset},${release},${l.allocation_revision}) returning id`;
      const journal=result==='POSTED'?await ledger.post(tx,{merchantId:f.merchantId,businessType:'SETTLEMENT',businessId:s.id,currency:'USD',description:'Synthetic B2.3 settlement evidence',lines:[
        ...(asset?[{accountCode:'PLATFORM_CASH' as const,merchantId:null,debit:asset},{accountCode:'PSP_CLEARING' as const,merchantId:null,credit:asset}]:[]),
        ...(release?[{accountCode:'MERCHANT_PENDING' as const,merchantId:f.merchantId,debit:release},{accountCode:'MERCHANT_AVAILABLE' as const,merchantId:f.merchantId,credit:release}]:[]),
      ]}):null;
      await tx`update public.settlement_items set finalized_asset_transfer=${asset},finalized_merchant_release=${release},restricted_hold=${l.held},applied_revision=${l.allocation_revision},finalization_result=${result},accounting_journal_id=${journal},accounting_finalized_at=now() where id=${i.id}`;
      await tx`update public.capture_accounting_lots set settlement_state='FINALIZED',finalized_settlement_item_id=${i.id} where id=${f.lotId}`;
      await tx`update public.settlements set status='SUCCEEDED',finalized_asset_transfer=${asset},finalized_merchant_release=${release},finalization_result=${result},accounting_journal_id=${journal},accounting_finalized_at=now() where id=${s.id}`;
    });
  }
  async function request(f:Capture,amount:number) { return (await refunds.create(actor(f),f.paymentId,randomUUID(),{amount})).value.id; }
  async function refundEvidence(f:Capture,r:string,amount:number) {
    const event:ProviderEvent={id:`evt_${randomUUID()}`,type:'refund.succeeded',externalType:'refund.updated',createdAt:new Date(0).toISOString(),data:{merchantId:f.merchantId,paymentId:f.paymentId,refundId:r,providerTransactionId:`re_${r}`,paymentIntentId:`pi_${f.paymentId}`,amount,currency:'USD'}};
    const [row]=await database.sql<{id:string}[]>`insert into public.webhook_events (provider,provider_event_id,event_type,signature,payload,status) values ('STRIPE',${event.id},${event.type},'isolated-fixture',${database.sql.json(event as never)},'IGNORED') returning id`;
    return row.id;
  }
  async function refund(f:Capture,amount:number) { const r=await request(f,amount); const id=await refundEvidence(f,r,amount); expect(await database.transaction(tx=>refunds.applySucceeded(tx,id))).toBe('PROCESSED'); return {r,id}; }

  it('keeps real scope admission dormant and runtime registration absent',async()=>{
    const f=await capture(); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000);
    await expect(database.transaction(tx=>new CaptureDisputeAccountingService(ledger,audit).applyOpened(tx,id))).rejects.toMatchObject({code:'ACCOUNTING_SCOPE_INACTIVE'});
    await balances(f,[10000,0,9700,0,0,300,0]);
    const [scopes]=await database.sql`select count(*)::integer as active from public.capture_accounting_scopes where status='ACTIVE'`; expect(scopes.active).toBe(0);
  });
  it.each([false,true])('opens from the correct lot liability (settled=%s)',async settled=>{
    const f=await capture(); const before=await original(f); if (settled) await settle(f); const d=await open(f);
    await balances(f,settled?[0,10000,0,4700,5000,300,0]:[10000,0,4700,0,5000,300,0]);
    expect(await allocation(d.id)).toEqual([expect.objectContaining({capture_lot_id:f.lotId,gross:'5000',funded:'5000',unfunded:'0',held:'5000',status:'OPEN'})]);
    expect(await lines(d.id,'DISPUTE_OPEN')).toEqual([{code:'DISPUTE_CLEARING',debit:'0',credit:'5000'},{code:settled?'MERCHANT_AVAILABLE':'MERCHANT_PENDING',debit:'5000',credit:'0'}]);
    expect(await state(f,d.id,d.inboxId)).toMatchObject({payment_status:'DISPUTED',status:'OPEN',inbox_status:'PROCESSED',audits:1}); expect(await original(f)).toEqual(before);
  });
  it.each([false,true])('records full gross, bounded funding and unfunded exposure (settled=%s)',async settled=>{
    const f=await capture(); if(settled) await settle(f); const d=await open(f,10000);
    expect((await allocation(d.id))[0]).toMatchObject({gross:'10000',funded:'9700',unfunded:'300'});
    await close(f,d,'MERCHANT_LOST'); await balances(f,[0,0,0,-300,0,300,0]);
    expect(await lines(d.id,'DISPUTE_CLOSE')).toEqual([{code:'DISPUTE_CLEARING',debit:'9700',credit:'0'},{code:'MERCHANT_AVAILABLE',debit:'300',credit:'0'},{code:settled?'PLATFORM_CASH':'PSP_CLEARING',debit:'0',credit:'10000'}]);
  });
  it.each([false,true])('wins into the current lot liability (settled=%s)',async settled=>{
    const f=await capture(); const d=await open(f); if(settled) await settle(f); const id=await close(f,d,'MERCHANT_WON');
    await balances(f,settled?[0,10000,0,9700,0,300,0]:[10000,0,9700,0,0,300,0]);
    expect(await state(f,d.id,id)).toMatchObject({payment_status:'CAPTURED',status:'CLOSED',outcome:'MERCHANT_WON',audits:2,inbox_status:'PROCESSED'});
  });
  it.each([false,true])('recognizes loss against actual unsettled/cash principal (settled=%s)',async settled=>{
    const f=await capture(); const d=await open(f); if(settled) await settle(f); await close(f,d,'MERCHANT_LOST');
    await balances(f,settled?[0,5000,0,4700,0,300,0]:[5000,0,4700,0,0,300,0]);
    expect((await allocation(d.id))[0]).toMatchObject({status:'CLOSED',outcome:'MERCHANT_LOST',gross:'5000'});
    await expect(request(f,5001)).rejects.toMatchObject({code:'REFUND_CAPACITY_UNAVAILABLE'});
  });
  it.each(['MERCHANT_WON','MERCHANT_LOST'] as const)('splits mixed capture sources and restoration for %s',async outcome=>{
    const a=await capture(4000,120); await settle(a); const b=await capture(6000,180,a); const originals=[await original(a),await original(b)];
    const d=await open(a,5000); expect(await allocation(d.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({capture_lot_id:a.lotId,gross:'4000',funded:'3880',unfunded:'120'}),expect.objectContaining({capture_lot_id:b.lotId,gross:'1000',funded:'1000',unfunded:'0'})]));
    await balances(a,[6000,4000,4820,0,4880,300,0]); await close(a,d,outcome);
    await balances(a,outcome==='MERCHANT_WON'?[6000,4000,5820,3880,0,300,0]:[5000,0,4820,-120,0,300,0]);
    expect([await original(a),await original(b)]).toEqual(originals);
  });
  it('attributes after a confirmed partial refund and respects FIFO chronology',async()=>{
    const f=await capture(); await refund(f,5000); const d=await open(f,5000);
    expect((await allocation(d.id))[0]).toMatchObject({gross:'5000',funded:'4850',unfunded:'150'});
    await close(f,d,'MERCHANT_LOST'); await balances(f,[0,0,0,-150,0,300,150]);
    expect(await state(f,d.id,d.inboxId)).toMatchObject({payment_status:'PARTIALLY_REFUNDED',refunded_amount:'5000'});
  });
  it.each(['MERCHANT_WON','MERCHANT_LOST'] as const)('adjusts a disjoint refund hold before %s without rewriting its journal',async outcome=>{
    const f=await capture(); const d=await open(f); const hold=await fingerprint(f); const {r,id}=await refund(f,5000);
    await balances(f,[5000,0,0,0,4850,300,150]); const a=(await allocation(d.id))[0]; expect(a).toMatchObject({funded:'5000',held:'4850',unfunded:'0'});
    const [e]=await database.sql<{id:string;journal_id:string;hold_delta:string;cause_refund_id:string;provider_event_id:string}[]>`select id,journal_id,hold_delta::text,cause_refund_id,provider_event_id from public.dispute_hold_effects where allocation_id=${a.id}`;
    expect(e).toMatchObject({hold_delta:'-150',cause_refund_id:r,provider_event_id:id});
    expect(await lines(e.id,'DISPUTE_HOLD_ADJUSTMENT')).toEqual([{code:'DISPUTE_CLEARING',debit:'150',credit:'0'},{code:'MERCHANT_PENDING',debit:'0',credit:'150'}]);
    await expect(database.sql`update public.ledger_transactions set description='changed' where id=${e.journal_id}`).rejects.toThrow(/immutable/i);
    await expect(database.sql`update public.dispute_hold_effects set hold_delta=-149 where id=${e.id}`).rejects.toThrow(/append-only/i);
    const [unchanged]=await database.sql`select to_jsonb(t) as journal from public.ledger_transactions t where business_type='DISPUTE_OPEN' and business_id=${d.id}`;
    expect((hold.journals as unknown[])).toContainEqual(unchanged.journal);
    await close(f,d,outcome); await balances(f,outcome==='MERCHANT_WON'?[5000,0,4850,0,0,300,150]:[0,0,0,-150,0,300,150]);
  });
  it('adjusts another disjoint case on loss and avoids phantom debt from its stale unfunded estimate',async()=>{
    const f=await capture(); const first=await open(f,5000); const second=await open(f,5000);
    expect((await allocation(second.id))[0]).toMatchObject({funded:'4700',unfunded:'300'});
    await close(f,second,'MERCHANT_LOST'); await balances(f,[5000,0,0,0,4700,300,0]);
    const [e]=await database.sql`select cause_dispute_id,hold_delta::text from public.dispute_hold_effects where payment_id=${f.paymentId}`;
    expect(e).toEqual({cause_dispute_id:second.id,hold_delta:'-300'}); expect((await allocation(first.id))[0].held).toBe('4700');
    const [p]=await database.sql`select status from public.payments where id=${f.paymentId}`; expect(p.status).toBe('DISPUTED');
    await close(f,first,'MERCHANT_WON'); await balances(f,[5000,0,4700,0,0,300,0]);
  });
  it('reduces settled holds into available before a disjoint refund',async()=>{
    const f=await capture(); const d=await open(f); await settle(f); await refund(f,5000);
    await balances(f,[0,5000,0,0,4850,300,150]); await close(f,d,'MERCHANT_LOST'); await balances(f,[0,0,0,-150,0,300,150]);
  });
  it('supports zero funded entitlement without empty journals or imaginary money',async()=>{
    const f=await capture(1000,1000); const d=await open(f,1000); expect(await lines(d.id,'DISPUTE_OPEN')).toEqual([]);
    await close(f,d,'MERCHANT_WON'); await balances(f,[1000,0,0,0,0,1000,0]); expect(await lines(d.id,'DISPUTE_CLOSE')).toEqual([]);
  });
  it('wins only the remaining hold after another case loss reduces its original funding to zero',async()=>{
    const f=await capture(1000,900); const a=await open(f,500),b=await open(f,500);
    await close(f,b,'MERCHANT_LOST'); await balances(f,[500,0,0,-400,0,900,0]);
    expect((await allocation(a.id))[0]).toMatchObject({funded:'100',held:'0'});
    await close(f,a,'MERCHANT_WON'); expect(await lines(a.id,'DISPUTE_CLOSE')).toEqual([]); await balances(f,[500,0,0,-400,0,900,0]);
  });
  it.each(['OPEN','MERCHANT_WON','MERCHANT_LOST'] as const)('replays %s with one financial effect and stable allocations',async mode=>{
    const f=await capture(); const d=await open(f); if(mode!=='OPEN') await close(f,d,mode); const before=await fingerprint(f); const rows=await allocation(d.id);
    const id=await evidence(f,d.provider,mode==='OPEN'?'dispute.opened':'dispute.closed',d.amount,mode==='OPEN'?undefined:mode);
    expect(await apply(id,mode!=='OPEN')).toBe('PROCESSED'); expect(await apply(id,mode!=='OPEN')).toBe('PROCESSED');
    expect(await fingerprint(f)).toEqual(before); expect(await allocation(d.id)).toEqual(rows);
    if(mode!=='OPEN') {const opened=await evidence(f,d.provider,'dispute.opened',d.amount); expect(await apply(opened)).toBe('PROCESSED'); expect(await fingerprint(f)).toEqual(before);}
  });
  it('retries a close-before-open prerequisite without inventing a hold',async()=>{
    const f=await capture(); const provider=`dp_${randomUUID()}`; const id=await evidence(f,provider,'dispute.closed',5000,'MERCHANT_WON'); const before=await fingerprint(f);
    await expect(apply(id,true)).rejects.toBeInstanceOf(RetryableWebhookError); expect(await fingerprint(f)).toEqual(before);
    const [row]=await database.sql`select status,payload from public.webhook_events where id=${id}`; expect(row.status).toBe('IGNORED'); expect(row.payload).toBeTruthy();
    await open(f,5000,provider); expect(await apply(id,true)).toBe('PROCESSED'); await balances(f,[10000,0,9700,0,0,300,0]);
  });
  it.each(['MERCHANT_WON','MERCHANT_LOST'] as const)('B2.3.1 retries close-before-open during a pending capture, then applies %s once',async outcome=>{
    const f=await capture(4000,120); const attempt=randomUUID();
    await database.sql`update public.payments set status='CAPTURE_PENDING',amount=10000,authorized_amount=10000 where id=${f.paymentId}`;
    await database.sql`insert into public.payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id)
      values (${attempt},${f.merchantId},${f.paymentId},'CAPTURE','PENDING',6000,'USD',${`pi_${f.paymentId}`})`;
    const provider=`dp_${randomUUID()}`; const id=await evidence(f,provider,'dispute.closed',3000,outcome);
    await database.sql`update public.webhook_events set status='RETRY',attempts=1 where id=${id}`;
    const [inbox]=await database.sql`select to_jsonb(w) as evidence from public.webhook_events w where id=${id}`;
    const [scope]=await database.sql`select to_jsonb(s) as evidence from public.capture_accounting_scopes s where merchant_id=${f.merchantId} and currency='USD'`;
    const before=await fingerprint(f),originalCapture=await original(f);
    for(let retry=0;retry<3;retry++) await expect(apply(id,true)).rejects.toBeInstanceOf(RetryableWebhookError);
    expect(await fingerprint(f)).toEqual(before);
    const [untouched]=await database.sql`select
      (select count(*)::integer from public.disputes where payment_id=${f.paymentId}) as disputes,
      (select count(*)::integer from public.dispute_capture_allocations where payment_id=${f.paymentId}) as allocations,
      (select count(*)::integer from public.dispute_hold_effects where payment_id=${f.paymentId}) as holds,
      (select count(*)::integer from public.accounting_exceptions where payment_id=${f.paymentId}) as exceptions`;
    expect(untouched).toEqual({disputes:0,allocations:0,holds:0,exceptions:0});
    expect((await database.sql`select to_jsonb(w) as evidence from public.webhook_events w where id=${id}`)[0]).toEqual(inbox);
    expect((await database.sql`select to_jsonb(s) as evidence from public.capture_accounting_scopes s where merchant_id=${f.merchantId} and currency='USD'`)[0]).toEqual(scope);
    await balances(f,[4000,0,3880,0,0,120,0]);
    const captured:ProviderEvent={id:`evt_${randomUUID()}`,type:'payment.capture_succeeded',externalType:'payment_intent.succeeded',createdAt:new Date(0).toISOString(),data:{
      merchantId:f.merchantId,paymentId:f.paymentId,attemptId:attempt,providerTransactionId:`pi_${f.paymentId}`,paymentIntentId:`pi_${f.paymentId}`,amount:6000,currency:'USD'}};
    await database.transaction(tx=>business.handle(tx,captured));
    await expect(apply(id,true)).rejects.toBeInstanceOf(RetryableWebhookError);
    const [lots]=await database.sql`select count(*)::integer as count,sum(original_gross)::text as gross,sum(original_fee)::text as fee from public.capture_accounting_lots where payment_id=${f.paymentId}`;
    expect(lots).toEqual({count:2,gross:'10000',fee:'300'});
    const d=await open(f,3000,provider); const frozen=await allocation(d.id);
    expect(frozen).toEqual([expect.objectContaining({capture_lot_id:f.lotId,gross:'3000',funded:'3000',unfunded:'0',status:'OPEN'})]);
    expect(await lines(d.id,'DISPUTE_OPEN')).toEqual([{code:'DISPUTE_CLEARING',debit:'0',credit:'3000'},{code:'MERCHANT_PENDING',debit:'3000',credit:'0'}]);
    await balances(f,[10000,0,6700,0,3000,300,0]);
    expect(await apply(id,true)).toBe('PROCESSED'); const committed=await fingerprint(f),closed=await allocation(d.id);
    expect(closed).toEqual([expect.objectContaining({capture_lot_id:f.lotId,gross:'3000',funded:'3000',status:'CLOSED',outcome})]);
    expect(await lines(d.id,'DISPUTE_CLOSE')).toEqual([{code:'DISPUTE_CLEARING',debit:'3000',credit:'0'},
      {code:outcome==='MERCHANT_WON'?'MERCHANT_PENDING':'PSP_CLEARING',debit:'0',credit:'3000'}]);
    expect(await apply(id,true)).toBe('PROCESSED'); expect(await fingerprint(f)).toEqual(committed); expect(await allocation(d.id)).toEqual(closed);
    expect(await state(f,d.id,id)).toMatchObject({payment_status:'CAPTURED',status:'CLOSED',outcome,inbox_status:'PROCESSED',audits:2});
    await balances(f,outcome==='MERCHANT_WON'?[10000,0,9700,0,0,300,0]:[7000,0,6700,0,0,300,0]);
    expect(await original(f)).toEqual(originalCapture);
    const [complete]=await database.sql`select
      (select count(*)::integer from public.ledger_transactions where merchant_id=${f.merchantId}) as journals,
      (select count(*)::integer from public.accounting_exceptions where payment_id=${f.paymentId}) as exceptions`;
    expect(complete).toEqual({journals:4,exceptions:0});
    expect((await database.sql`select to_jsonb(s) as evidence from public.capture_accounting_scopes s where merchant_id=${f.merchantId} and currency='USD'`)[0]).toEqual(scope);
  });
  it.each([{providerTransactionId:'dp_wrong'},{currency:'EUR'},{amount:0},{paymentIntentId:'pi_wrong'},
    {paymentIntentId:undefined},{outcome:undefined}] as Partial<ProviderEventData>[])('B2.3.1 retains untrusted close-before-open evidence %j as accounting review',async changes=>{
    const f=await capture(); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.closed',5000,'MERCHANT_WON',changes); const before=await fingerprint(f);
    expect(await apply(id,true)).toBe('ACCOUNTING_EXCEPTION'); expect(await apply(id,true)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    const [rows]=await database.sql`select
      (select count(*)::integer from public.accounting_exceptions where provider_event_id=${id}) as exceptions,
      (select count(*)::integer from public.disputes where payment_id=${f.paymentId}) as disputes,
      (select status from public.webhook_events where id=${id}) as status`;
    expect(rows).toEqual({exceptions:1,disputes:0,status:'ACCOUNTING_EXCEPTION'});
  });
  it('B2.3.1 keeps trusted Charge-only close-before-open evidence retryable',async()=>{
    const f=await capture(); const charge=`ch_${randomUUID()}`,provider=`dp_${randomUUID()}`;
    await database.sql`insert into public.provider_transactions (merchant_id,payment_id,payment_attempt_id,provider,provider_transaction_id,payment_intent_id,charge_id,provider_idempotency_key,operation,status,amount,currency)
      values (${f.merchantId},${f.paymentId},${f.attemptId},'STRIPE',${`pi_${f.paymentId}`},${`pi_${f.paymentId}`},${charge},${`capture:${f.attemptId}`},'CAPTURE','succeeded',10000,'USD')`;
    const id=await evidence(f,provider,'dispute.closed',5000,'MERCHANT_WON',{paymentIntentId:undefined,chargeId:charge}); const before=await fingerprint(f);
    await expect(apply(id,true)).rejects.toBeInstanceOf(RetryableWebhookError); expect(await fingerprint(f)).toEqual(before);
    const [exceptions]=await database.sql`select count(*)::integer as count from public.accounting_exceptions where provider_event_id=${id}`; expect(exceptions.count).toBe(0);
    await open(f,5000,provider); expect(await apply(id,true)).toBe('PROCESSED'); await balances(f,[10000,0,9700,0,0,300,0]);
  });
  it('B2.3.1 validates known mirror contradictions before the missing-open retry',async()=>{
    const f=await capture(); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.closed',5000,'MERCHANT_WON'); const before=await fingerprint(f);
    await database.sql`insert into public.provider_transactions (merchant_id,payment_id,payment_attempt_id,provider,provider_transaction_id,payment_intent_id,provider_idempotency_key,operation,status,amount,currency)
      values (${f.merchantId},${f.paymentId},${f.attemptId},'STRIPE',${`pi_${f.paymentId}`},'pi_wrong',${`capture:${f.attemptId}`},'CAPTURE','succeeded',10000,'USD')`;
    expect(await apply(id,true)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    const [row]=await database.sql`select status from public.webhook_events where id=${id}`; expect(row.status).toBe('ACCOUNTING_EXCEPTION');
  });
  it.each(['MERCHANT_WON','MERCHANT_LOST'] as const)('B2.3.1 rolls back a close journal failure and safely replays %s',async outcome=>{
    const f=await capture(); const d=await open(f); const id=await evidence(f,d.provider,'dispute.closed',5000,outcome);
    await database.sql`update public.webhook_events set status='RETRY' where id=${id}`;
    const before=await fingerprint(f),rows=await allocation(d.id);
    const [inbox]=await database.sql`select to_jsonb(w) as evidence from public.webhook_events w where id=${id}`;
    const spy=jest.spyOn(ledger,'post').mockImplementationOnce(async(tx,input)=>{
      expect(input.businessType).toBe('DISPUTE_CLOSE'); await LedgerService.prototype.post.call(ledger,tx,input); throw new Error('Injected after close journal');
    });
    try {await expect(apply(id,true)).rejects.toThrow('Injected after close journal');} finally {spy.mockRestore();}
    expect(await fingerprint(f)).toEqual(before); expect(await allocation(d.id)).toEqual(rows);
    expect((await database.sql`select to_jsonb(w) as evidence from public.webhook_events w where id=${id}`)[0]).toEqual(inbox);
    expect(await state(f,d.id,id)).toMatchObject({status:'OPEN',outcome:null,payment_status:'DISPUTED',inbox_status:'RETRY',audits:1});
    const [exceptions]=await database.sql`select count(*)::integer as count from public.accounting_exceptions where provider_event_id=${id}`; expect(exceptions.count).toBe(0);
    expect(await apply(id,true)).toBe('PROCESSED'); const committed=await fingerprint(f); expect(await apply(id,true)).toBe('PROCESSED'); expect(await fingerprint(f)).toEqual(committed);
    await balances(f,outcome==='MERCHANT_WON'?[10000,0,9700,0,0,300,0]:[5000,0,4700,0,0,300,0]);
    expect(await state(f,d.id,id)).toMatchObject({status:'CLOSED',outcome,inbox_status:'PROCESSED',audits:2});
  });
  it.each(['MERCHANT_WON','MERCHANT_LOST'] as const)('retains contradictory terminal evidence after %s',async outcome=>{
    const f=await capture(); const d=await open(f); await close(f,d,outcome); const before=await fingerprint(f);
    const id=await evidence(f,d.provider,'dispute.closed',5000,outcome==='MERCHANT_WON'?'MERCHANT_LOST':'MERCHANT_WON');
    expect(await apply(id,true)).toBe('ACCOUNTING_EXCEPTION'); expect(await apply(id,true)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    const [e]=await database.sql`select count(*)::integer as count,min(status) as status from public.accounting_exceptions where provider_event_id=${id}`; expect(e).toEqual({count:1,status:'OPEN'});
  });
  it.each([{currency:'EUR'},{paymentIntentId:'pi_wrong'},{providerTransactionId:'dp_wrong'},{amount:10001},{amount:0},{amount:0.5}] as Partial<ProviderEventData>[])('retains invalid scoped evidence %j without financial application',async changes=>{
    const f=await capture(); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000,undefined,changes); const before=await fingerprint(f);
    expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    const [row]=await database.sql`select status,processed_at from public.webhook_events where id=${id}`; expect(row).toEqual({status:'ACCOUNTING_EXCEPTION',processed_at:null});
    const [scope]=await database.sql`select status from public.capture_accounting_scopes where merchant_id=${f.merchantId}`; expect(scope.status).toBe('REVIEW_REQUIRED');
  });
  it('rejects cross-payment provider dispute reuse and preserves both original owners',async()=>{
    const a=await capture(),b=await capture(); const d=await open(a); const beforeA=await fingerprint(a),beforeB=await fingerprint(b);
    const id=await evidence(b,d.provider,'dispute.opened',5000); expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION');
    expect(await fingerprint(a)).toEqual(beforeA); expect(await fingerprint(b)).toEqual(beforeB);
    const [e]=await database.sql`select dispute_id,observed_conflict from public.accounting_exceptions where provider_event_id=${id}`;
    expect(e.dispute_id).toBeNull(); expect(e.observed_conflict).toMatchObject({recordedDispute:{id:d.id,payment_id:a.paymentId}});
  });
  it('uses a matching charge mirror when optional PaymentIntent is absent and rejects known contradictions',async()=>{
    const f=await capture(); const charge=`ch_${randomUUID()}`;
    await database.sql`insert into public.provider_transactions (merchant_id,payment_id,payment_attempt_id,provider,provider_transaction_id,payment_intent_id,charge_id,provider_idempotency_key,operation,status,amount,currency)
      values (${f.merchantId},${f.paymentId},${f.attemptId},'STRIPE',${`pi_${f.paymentId}`},${`pi_${f.paymentId}`},${charge},${`capture:${f.attemptId}`},'CAPTURE','succeeded',10000,'USD')`;
    const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000,undefined,{paymentIntentId:undefined,chargeId:charge}); expect(await apply(id)).toBe('PROCESSED');
    const bad=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',1000,undefined,{chargeId:'ch_wrong'}); const before=await fingerprint(f);
    expect(await apply(bad)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
  });
  it('preserves pending refund capacity and idempotent overlap exception evidence',async()=>{
    const f=await capture(); const r=await request(f,6000); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000); const before=await fingerprint(f);
    expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION'); expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    const [a]=await database.sql`select status,reserved_gross::text from public.refund_capture_allocations where refund_id=${r}`; expect(a).toEqual({status:'RESERVED',reserved_gross:'6000'});
    const success=await refundEvidence(f,r,6000); expect(await database.transaction(tx=>refunds.applySucceeded(tx,success))).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    const [e]=await database.sql`select observed_conflict from public.accounting_exceptions where provider_event_id=${id}`; expect(e.observed_conflict).toMatchObject({refunds:[expect.objectContaining({refund_id:r,reserved_gross:'6000'})]});
  });
  it('does not overwrite an independent CAPTURE_PENDING state with a dispute outcome',async()=>{
    const f=await capture(); const d=await open(f); await database.sql`update public.payments set status='CAPTURE_PENDING' where id=${f.paymentId}`;
    const id=await evidence(f,d.provider,'dispute.closed',5000,'MERCHANT_WON'); const before=await fingerprint(f);
    expect(await apply(id,true)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    const [p]=await database.sql`select status from public.payments where id=${f.paymentId}`; expect(p.status).toBe('CAPTURE_PENDING'); expect((await allocation(d.id))[0].status).toBe('OPEN');
  });
  it.each(['journal','finalization'] as const)('rolls back an opening at %s and safely retries the retained inbox',async point=>{
    const f=await capture(); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000); const before=await fingerprint(f);
    const spy=point==='journal'?jest.spyOn(ledger,'post').mockImplementationOnce(async(tx,input)=>{const result=await LedgerService.prototype.post.call(ledger,tx,input); expect(result).toBeTruthy(); throw new Error('Injected after journal');}):null;
    try {await expect(database.transaction(async tx=>{await service.applyOpened(tx,id); if(point==='finalization') throw new Error('Injected before commit');})).rejects.toThrow(/Injected/);} finally {spy?.mockRestore();}
    expect(await fingerprint(f)).toEqual(before); const [row]=await database.sql`select count(*)::integer as count from public.dispute_capture_allocations where payment_id=${f.paymentId}`; expect(row.count).toBe(0);
    const [inbox]=await database.sql`select status from public.webhook_events where id=${id}`; expect(inbox.status).toBe('IGNORED'); expect(await apply(id)).toBe('PROCESSED'); await balances(f,[10000,0,4700,0,5000,300,0]);
  });
  it('rolls back hold adjustment and loss together, then applies the same evidence once',async()=>{
    const f=await capture(); const a=await open(f,5000),b=await open(f,5000); const before=await fingerprint(f),rows=await allocation(a.id);
    const id=await evidence(f,b.provider,'dispute.closed',5000,'MERCHANT_LOST');
    await expect(database.transaction(async tx=>{await service.applyClosed(tx,id); throw new Error('Injected after finalization');})).rejects.toThrow('Injected');
    expect(await fingerprint(f)).toEqual(before); expect(await allocation(a.id)).toEqual(rows);
    expect(await apply(id,true)).toBe('PROCESSED'); expect(await apply(id,true)).toBe('PROCESSED'); await balances(f,[5000,0,0,0,4700,300,0]);
  });
  it('rolls back rejected-operation evidence with its transaction and retries one durable exception',async()=>{
    const f=await capture(); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',10001);
    await expect(database.transaction(async tx=>{expect(await service.applyOpened(tx,id)).toBe('ACCOUNTING_EXCEPTION'); throw new Error('Injected abort');})).rejects.toThrow('Injected abort');
    const [e]=await database.sql`select count(*)::integer as count from public.accounting_exceptions where provider_event_id=${id}`; expect(e.count).toBe(0);
    expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION'); expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION'); await balances(f,[10000,0,9700,0,0,300,0]);
  });

  function signal() {let resolve!:()=>void; const promise=new Promise<void>(done=>{resolve=done;}); return {promise,resolve};}
  async function barrier(promise:Promise<void>) {let timer!:ReturnType<typeof setTimeout>; try {await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Barrier timeout')),5000);})]);} finally {clearTimeout(timer);}}
  async function serial(f:Capture,first:(tx:DbTransaction)=>Promise<unknown>,second:()=>Promise<unknown>) {
    const held=signal(),release=signal(); let owner=0;
    const a=database.transaction(async tx=>{await tx`set local statement_timeout='10s'`; const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; owner=pid.pid;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${f.merchantId}:USD`},0))`; const result=await first(tx); held.resolve(); await barrier(release.promise); return result;});
    const checked=a.then(value=>({value}),error=>({error: error as Error})); let b:Promise<{value:unknown}|{error:Error}>|undefined; let failure:unknown;
    try {await barrier(held.promise); b=second().then(value=>({value}),error=>({error:error as Error})); let observed=false; const deadline=Date.now()+5000;
      while(Date.now()<deadline) {const waiting=await database.sql`select pid from pg_stat_activity where datname=current_database() and ${owner}=any(pg_blocking_pids(pid))`; if(waiting.length){observed=true;break;} await new Promise(done=>setTimeout(done,10));} expect(observed).toBe(true);
    } catch(error){failure=error instanceof Error?error:new Error(String(error));} finally {release.resolve();}
    const [one,two]=await Promise.all([checked,b]); if(failure instanceof Error) throw failure; if('error' in one) throw one.error; if(two && 'error' in two) throw two.error; return two?.value;
  }
  it('serializes concurrent distinct duplicate opens with one lot assignment, journal and audit',async()=>{
    const f=await capture(); const provider=`dp_${randomUUID()}`; const a=await evidence(f,provider,'dispute.opened',5000),b=await evidence(f,provider,'dispute.opened',5000);
    expect(await serial(f,tx=>service.applyOpened(tx,a),()=>apply(b))).toBe('PROCESSED');
    const [d]=await database.sql<{id:string}[]>`select id from public.disputes where provider_dispute_id=${provider}`; expect(await allocation(d.id)).toHaveLength(1); expect(await state(f,d.id,b)).toMatchObject({audits:1}); await balances(f,[10000,0,4700,0,5000,300,0]);
  });
  it('serializes concurrent duplicate losses without consuming principal twice',async()=>{
    const f=await capture(); const d=await open(f); const a=await evidence(f,d.provider,'dispute.closed',5000,'MERCHANT_LOST'),b=await evidence(f,d.provider,'dispute.closed',5000,'MERCHANT_LOST');
    expect(await serial(f,tx=>service.applyClosed(tx,a),()=>apply(b,true))).toBe('PROCESSED'); expect(await state(f,d.id,b)).toMatchObject({audits:2}); await balances(f,[5000,0,4700,0,0,300,0]);
  });
  it('serializes refund reservation before incompatible dispute opening without changing the reservation',async()=>{
    const f=await capture(); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000); const r=await request(f,6000);
    expect(await serial(f,async tx=>{await tx`select id from public.refunds where id=${r} for update`;},()=>apply(id))).toBe('ACCOUNTING_EXCEPTION'); await balances(f,[10000,0,9700,0,0,300,0]);
  });
  it.each(['loss-first','refund-first'] as const)('serializes dispute loss and disjoint refund success with exact combined debt (%s)',async order=>{
    const f=await capture(); const r=await request(f,5000),d=await open(f); const loss=await evidence(f,d.provider,'dispute.closed',5000,'MERCHANT_LOST'),success=await refundEvidence(f,r,5000);
    const outcome=order==='loss-first'?await serial(f,tx=>service.applyClosed(tx,loss),()=>database.transaction(tx=>refunds.applySucceeded(tx,success)))
      :await serial(f,tx=>refunds.applySucceeded(tx,success),()=>apply(loss,true));
    expect(outcome).toBe('PROCESSED'); await balances(f,[0,0,0,-150,0,300,150]);
  });
  it.each(['open-first','refund-first'] as const)('serializes dispute open versus confirmed disjoint refund (%s)',async order=>{
    const f=await capture(); const r=await request(f,5000); const opened=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000),success=await refundEvidence(f,r,5000);
    const outcome=order==='open-first'?await serial(f,tx=>service.applyOpened(tx,opened),()=>database.transaction(tx=>refunds.applySucceeded(tx,success)))
      :await serial(f,tx=>refunds.applySucceeded(tx,success),()=>apply(opened));
    expect(outcome).toBe('PROCESSED'); await balances(f,[5000,0,0,0,4850,300,150]);
    const [p]=await database.sql`select status,refunded_amount::text from public.payments where id=${f.paymentId}`; expect(p).toEqual({status:'DISPUTED',refunded_amount:'5000'});
  });
  it('serializes two distinct opens competing for the same principal capacity',async()=>{
    const f=await capture(); const a=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',6000),b=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000);
    expect(await serial(f,tx=>service.applyOpened(tx,a),()=>apply(b))).toBe('ACCOUNTING_EXCEPTION'); await balances(f,[10000,0,3700,0,6000,300,0]);
    const [rows]=await database.sql`select count(*)::integer as count,sum(gross_principal)::text as gross from public.dispute_capture_allocations where payment_id=${f.paymentId}`; expect(rows).toEqual({count:1,gross:'6000'});
  });
  it('serializes two confirmed causes adjusting the same hold and preserves both immutable effects',async()=>{
    const f=await capture(); const d=await open(f,9500),a=await request(f,250),b=await request(f,250); const first=await refundEvidence(f,a,250),second=await refundEvidence(f,b,250);
    expect(await serial(f,tx=>refunds.applySucceeded(tx,first),()=>database.transaction(tx=>refunds.applySucceeded(tx,second)))).toBe('PROCESSED');
    await balances(f,[9500,0,0,0,9215,300,15]); expect((await allocation(d.id))[0]).toMatchObject({funded:'9500',held:'9215'});
    const effects=await database.sql`select hold_delta::text,cause_refund_id,provider_event_id from public.dispute_hold_effects where payment_id=${f.paymentId} order by hold_delta desc`;
    expect(effects).toEqual([{hold_delta:'-43',cause_refund_id:a,provider_event_id:first},{hold_delta:'-242',cause_refund_id:b,provider_event_id:second}]);
    expect(await database.transaction(tx=>refunds.applySucceeded(tx,second))).toBe('PROCESSED'); expect(await database.sql`select id from public.dispute_hold_effects where payment_id=${f.paymentId}`).toHaveLength(2);
  });
  it('shares the payout reservation key and rejects spending the newly held available funds',async()=>{
    const f=await capture(); await settle(f); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000);
    await expect(serial(f,tx=>service.applyOpened(tx,id),()=>payouts.request(actor(f),randomUUID(),{amount:8000,currency:'USD',destinationToken:'bank_test'}))).rejects.toMatchObject({code:'INSUFFICIENT_AVAILABLE_BALANCE'}); await balances(f,[0,10000,0,4700,5000,300,0]);
  });
  it('waits for actual capture completion before locking child rows or allocating new principal',async()=>{
    const f=await capture(4000,120); const attempt=randomUUID();
    await database.sql`update public.payments set status='CAPTURE_PENDING',amount=10000,authorized_amount=10000 where id=${f.paymentId}`;
    await database.sql`insert into public.payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id) values (${attempt},${f.merchantId},${f.paymentId},'CAPTURE','PENDING',6000,'USD',${`pi_${f.paymentId}`})`;
    const event:ProviderEvent={id:`evt_${randomUUID()}`,type:'payment.capture_succeeded',externalType:'payment_intent.succeeded',createdAt:new Date(0).toISOString(),data:{merchantId:f.merchantId,paymentId:f.paymentId,attemptId:attempt,providerTransactionId:`pi_${f.paymentId}`,paymentIntentId:`pi_${f.paymentId}`,amount:6000,currency:'USD'}};
    const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000); expect(await serial(f,tx=>business.handle(tx,event),()=>apply(id))).toBe('PROCESSED'); await balances(f,[10000,0,4820,0,4880,300,0]);
    const [rows]=await database.sql`select count(*)::integer as count,sum(gross_principal)::text as gross from public.dispute_capture_allocations where payment_id=${f.paymentId}`; expect(rows).toEqual({count:2,gross:'5000'});
  });
  it.each(['settlement-first','dispute-first'] as const)('allows actual legacy generation FK checks without deadlock (%s)',async order=>{
    const f=await capture(); const originalCapture=await original(f); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000);
    const selected=signal(),insertAllowed=signal(),paymentLocked=signal(),attemptAllowed=signal(); let generatorPid=0,disputePid=0;
    let generating:Promise<string[]>|undefined,applying:Promise<unknown>|undefined; let results:PromiseSettledResult<unknown>[]=[];
    const startGeneration=()=>{
      const controlled=new Proxy(database,{get(target,property,receiver){
        if(property!=='transaction') return Reflect.get(target,property,receiver) as unknown;
        return (work:Parameters<DatabaseService['transaction']>[0])=>target.transaction(async tx=>{
          await tx`set local statement_timeout='8s'`; const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; generatorPid=pid.pid;
          const observed=new Proxy(tx,{apply(query,thisArg,args:[TemplateStringsArray,...unknown[]]){
            if(args[0].join('?').includes('with eligible as materialized')) return (async()=>{const rows:unknown=await Reflect.apply(query,thisArg,args); expect(rows).toHaveLength(1); selected.resolve(); await barrier(insertAllowed.promise); return rows;})();
            return Reflect.apply(query,thisArg,args) as unknown;
          }}); return work(observed);
        });
      }});
      generating=new SettlementsService(controlled,ledger,audit).generate(f.merchantId); void generating.catch(()=>undefined);
    };
    const startDispute=()=>{
      applying=database.transaction(async tx=>{
        await tx`set local statement_timeout='8s'`; const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; disputePid=pid.pid;
        const observed=new Proxy(tx,{apply(query,thisArg,args:[TemplateStringsArray,...unknown[]]){
          if(args[0].join('?').includes('for no key update')) return (async()=>{const rows:unknown=await Reflect.apply(query,thisArg,args); paymentLocked.resolve(); await barrier(attemptAllowed.promise); return rows;})();
          return Reflect.apply(query,thisArg,args) as unknown;
        }}); return service.applyOpened(observed,id);
      }); void applying.catch(()=>undefined);
    };
    try {
      if(order==='settlement-first'){startGeneration(); await barrier(selected.promise); startDispute();}
      else {startDispute(); await barrier(paymentLocked.promise); startGeneration(); await barrier(selected.promise);}
      await barrier(paymentLocked.promise); attemptAllowed.resolve(); let observed=false; const deadline=Date.now()+5000;
      while(Date.now()<deadline){const [row]=await database.sql<{waiting:boolean}[]>`select ${generatorPid}=any(pg_blocking_pids(${disputePid})) as waiting`; if(row.waiting){observed=true;break;} await new Promise(done=>setTimeout(done,10));}
      expect(observed).toBe(true);
    } finally {attemptAllowed.resolve(); insertAllowed.resolve(); results=await Promise.allSettled([generating,applying]);}
    expect(results.map(r=>r.status)).toEqual(['fulfilled','fulfilled']);
    // Generation remains legacy and is explicitly rejected as new-policy history;
    // the transaction commits an exception, not a speculative hold.
    expect((results[1] as PromiseFulfilledResult<string>).value).toBe('ACCOUNTING_EXCEPTION');
    const [i]=await database.sql`select i.gross_amount::text,i.net_amount::text,s.status from public.settlement_items i join public.settlements s on s.id=i.settlement_id where capture_attempt_id=${f.attemptId}`;
    expect(i).toEqual({gross_amount:'10000',net_amount:'9700',status:'PENDING'}); expect(await original(f)).toEqual(originalCapture); await balances(f,[10000,0,9700,0,0,300,0]);
  },20000);
  it('observes an actual uncommitted refund reservation blocking dispute admission',async()=>{
    const f=await capture(); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000); const held=signal(),release=signal(); let owner=0;
    const spy=jest.spyOn(outbox,'add').mockImplementationOnce(async(tx,input)=>{
      const result=await OutboxService.prototype.add.call(outbox,tx,input); const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; owner=pid.pid; held.resolve(); await barrier(release.promise); return result;
    });
    const creating=request(f,6000); void creating.catch(()=>undefined); let applying:Promise<string>|undefined; let results:PromiseSettledResult<unknown>[]=[];
    try {await barrier(held.promise); applying=apply(id); void applying.catch(()=>undefined); let observed=false; const deadline=Date.now()+5000;
      while(Date.now()<deadline){const rows=await database.sql`select pid from pg_stat_activity where datname=current_database() and ${owner}=any(pg_blocking_pids(pid))`; if(rows.length){observed=true;break;} await new Promise(done=>setTimeout(done,10));} expect(observed).toBe(true);
    } finally {release.resolve(); results=await Promise.allSettled([creating,applying]); spy.mockRestore();}
    expect(results.map(r=>r.status)).toEqual(['fulfilled','fulfilled']); expect((results[1] as PromiseFulfilledResult<string>).value).toBe('ACCOUNTING_EXCEPTION');
    const [a]=await database.sql`select reserved_gross::text,status from public.refund_capture_allocations where payment_id=${f.paymentId}`; expect(a).toEqual({reserved_gross:'6000',status:'RESERVED'}); await balances(f,[10000,0,9700,0,0,300,0]);
  });
  it('rolls back a refund journal failure together with its preceding hold adjustment',async()=>{
    const f=await capture(); const d=await open(f); const r=await request(f,5000); const id=await refundEvidence(f,r,5000); const before=await fingerprint(f),rows=await allocation(d.id);
    const spy=jest.spyOn(ledger,'post').mockImplementation(async(tx,input)=>{
      const result=await LedgerService.prototype.post.call(ledger,tx,input); if(input.businessType==='REFUND') throw new Error('Injected after refund journal'); return result;
    });
    try {await expect(database.transaction(tx=>refunds.applySucceeded(tx,id))).rejects.toThrow('Injected after refund journal');} finally {spy.mockRestore();}
    expect(await fingerprint(f)).toEqual(before); expect(await allocation(d.id)).toEqual(rows);
    const [effects]=await database.sql`select count(*)::integer as count from public.dispute_hold_effects where payment_id=${f.paymentId}`; expect(effects.count).toBe(0);
    expect(await database.transaction(tx=>refunds.applySucceeded(tx,id))).toBe('PROCESSED'); await balances(f,[5000,0,0,0,4850,300,150]);
  });
  it('validates original provider identity before accepting a financial replay',async()=>{
    const f=await capture(); const d=await open(f); const before=await fingerprint(f);
    const bad=await evidence(f,d.provider,'dispute.opened',5000,undefined,{paymentIntentId:'pi_wrong'}); expect(await apply(bad)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
  });
  it('preserves an unresolved provider relationship without inventing a dispute',async()=>{
    const f=await capture(); const id=await evidence(f,`dp_${randomUUID()}`,'dispute.opened',5000,undefined,{paymentIntentId:undefined});
    expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION'); const [rows]=await database.sql`select count(*)::integer as count from public.disputes where payment_id=${f.paymentId}`; expect(rows.count).toBe(0); await balances(f,[10000,0,9700,0,0,300,0]);
  });
  it('detects inconsistent parent outcomes before the duplicate guard',async()=>{
    const f=await capture(); const d=await open(f); await database.sql`update public.disputes set status='CLOSED',outcome='MERCHANT_WON' where id=${d.id}`;
    const id=await evidence(f,d.provider,'dispute.closed',5000,'MERCHANT_WON'); const before=await fingerprint(f);
    expect(await apply(id,true)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before); expect((await allocation(d.id))[0].status).toBe('OPEN');
  });
  it('refuses refund finalization against inconsistent dispute workflow/effect history',async()=>{
    const f=await capture(); const d=await open(f); const r=await request(f,5000); await database.sql`update public.disputes set status='CLOSED',outcome='MERCHANT_WON' where id=${d.id}`;
    const id=await refundEvidence(f,r,5000),before=await fingerprint(f);
    expect(await database.transaction(tx=>refunds.applySucceeded(tx,id))).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    const [a]=await database.sql`select status from public.refund_capture_allocations where refund_id=${r}`; expect(a.status).toBe('RESERVED');
  });
  it('freezes dispute attribution on replay after another capture lot appears',async()=>{
    const f=await capture(); const d=await open(f); const before=await allocation(d.id); await capture(1000,30,f);
    const id=await evidence(f,d.provider,'dispute.opened',5000); expect(await apply(id)).toBe('PROCESSED'); expect(await allocation(d.id)).toEqual(before); await balances(f,[11000,0,5670,0,5000,330,0]);
  });
});
