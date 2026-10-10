import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { AuthActor } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DatabaseService, type DbTransaction } from '../../src/database/database.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { PaymentCommandHandlerService } from '../../src/payment-commands/payment-command-handler.service';
import { type PaymentProvider, UnknownProviderOutcomeError } from '../../src/payment-provider/payment-provider.types';
import { PayoutsService } from '../../src/payouts/payouts.service';
import type { ProviderCommandEventType } from '../../src/rabbitmq/rabbitmq.types';
import { CaptureRefundAccountingService } from '../../src/refunds/capture-refund-accounting.service';
import { RefundsService } from '../../src/refunds/refunds.service';
import { WebhookBusinessService } from '../../src/webhooks/webhook-business.service';
import type { ProviderEvent, ProviderEventData } from '../../src/webhooks/webhook.types';
import { accountContributions, captureFixture } from '../support/accounting-fixtures';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Capture = Awaited<ReturnType<typeof captureFixture>> & { lotId:string };
const asError=(error:unknown):Error => error instanceof Error?error:new Error(String(error));
// Test-only admission override. Production has neither a registration nor an
// activation switch. Every fixture scope remains FOUNDATION_ONLY/REVIEW_REQUIRED.
class DormantRefundHarness extends CaptureRefundAccountingService {
  protected assertActiveScope(status:string):void {
    if (!['FOUNDATION_ONLY','REVIEW_REQUIRED'].includes(status)) throw new Error('Missing dormant fixture scope');
  }
}

describeDatabase('B2.2 dormant refund service transactions (not runtime dispatch)', () => {
  let database:DatabaseService; let ledger:LedgerService; let service:DormantRefundHarness;
  let audit:AuditService; let outbox:OutboxService; let idempotency:IdempotencyService; let payouts:PayoutsService;
  beforeAll(() => {
    database=new DatabaseService(new ConfigService({DATABASE_URL:process.env.DATABASE_URL}));
    ledger=new LedgerService(database); audit=new AuditService(); outbox=new OutboxService(); idempotency=new IdempotencyService(database);
    service=new DormantRefundHarness(database,idempotency,outbox,audit,ledger);
    payouts=new PayoutsService(database,idempotency,ledger,outbox,audit);
  });
  afterAll(async () => { await database.onApplicationShutdown(); });
  function actor(f:Capture):AuthActor { return {id:randomUUID(),type:'API_KEY',role:'MERCHANT_ADMIN',merchantId:f.merchantId}; }
  async function capture(gross=10000,fee=300,scope?:{merchantId:string;paymentId:string}):Promise<Capture> {
    const f=await captureFixture(database,gross,fee,scope);
    await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD') on conflict do nothing`;
    const [lot]=await database.sql<{id:string}[]>`insert into capture_accounting_lots
      (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at,origin)
      select ${f.attemptId},${f.paymentId},${f.merchantId},'USD',id,${gross},${fee},${gross-fee},posted_at,posted_at,'NEW_CAPTURE'
      from ledger_transactions where id=${f.journalId} returning id`;
    return {...f,lotId:lot.id};
  }
  async function request(f:Capture,amount:number,key=randomUUID()) {
    return (await service.create(actor(f),f.paymentId,key,{amount})).value.id;
  }
  async function evidence(f:Capture,r:string,amount:number,type:'refund.succeeded'|'refund.failed'='refund.succeeded',changes:Partial<ProviderEventData>={}) {
    // Ordinary evidence explicitly repeats the matching capture identity.
    const payload:ProviderEvent={id:`evt_${randomUUID()}`,type,externalType:type==='refund.succeeded'?'refund.updated':'refund.failed',createdAt:new Date(0).toISOString(),
      data:{merchantId:f.merchantId,paymentId:f.paymentId,refundId:r,amount,currency:'USD',providerTransactionId:`re_${r}`,paymentIntentId:`pi_${f.paymentId}`,...changes}};
    const [row]=await database.sql<{id:string}[]>`insert into webhook_events (provider,provider_event_id,event_type,signature,payload,status)
      values ('STRIPE',${payload.id},${type},'isolated-fixture',${database.sql.json(payload as never)},'IGNORED') returning id`;
    return row.id;
  }
  const evidenceWithoutPaymentIntent=(f:Capture,r:string,amount:number,type:'refund.succeeded'|'refund.failed') => evidence(f,r,amount,type,{paymentIntentId:undefined});
  async function refundMirror(f:Capture,r:string,paymentIntentId:string|null,operation='REFUND',key=`refund:${r}`) {
    const [row]=await database.sql<{id:string}[]>`insert into provider_transactions
      (merchant_id,payment_id,refund_id,provider,provider_transaction_id,payment_intent_id,provider_idempotency_key,operation,status,amount,currency)
      values (${f.merchantId},${f.paymentId},${r},'STRIPE',${`re_${r}`},${paymentIntentId},${key},${operation},'pending',100,'USD') returning id`;
    return row.id;
  }
  const apply=(id:string,failed=false) => database.transaction((tx) => failed?service.applyFailed(tx,id):service.applySucceeded(tx,id));
  async function succeeded(f:Capture,r:string,amount:number) { const id=await evidence(f,r,amount); expect(await apply(id)).toBe('PROCESSED'); return id; }
  async function allocations(r:string) {
    return database.sql<{capture_lot_id:string;reserved_gross:string;status:string;confirmed_gross:string|null;confirmed_fee:string|null;journal_id:string|null;provider_event_id:string|null}[]>`select capture_lot_id,reserved_gross::text,status,confirmed_gross::text,confirmed_fee::text,journal_id,provider_event_id
      from refund_capture_allocations where refund_id=${r} order by capture_lot_id`;
  }
  async function state(f:Capture,r:string,id?:string) {
    const [row]=await database.sql`select p.status as payment_status,p.refunded_amount::text,p.captured_amount::text,p.version,r.status as refund_status,r.platform_fee_amount::text,
      (select count(*)::integer from ledger_transactions where business_type='REFUND' and business_id=r.id) as journals,
      (select count(*)::integer from audit_logs where target_id=p.id::text and action='refund.succeeded' and metadata->>'refundId'=r.id::text) as success_audits,
      (select status from webhook_events where id=${id??null}) as inbox_status from refunds r join payments p on p.id=r.payment_id where r.id=${r}`;
    return row;
  }
  async function journalLines(r:string) {
    return database.sql`select a.code,sum(e.debit)::text as debit,sum(e.credit)::text as credit from ledger_transactions t
      join ledger_entries e on e.transaction_id=t.id join ledger_accounts a on a.id=e.account_id
      where t.business_type='REFUND' and t.business_id=${r} group by a.code order by a.code`;
  }
  async function balances(f:Capture,expected:Record<string,string>) {
    const actual=await database.transaction((tx) => accountContributions(tx,f.merchantId));
    for (const [code,amount] of Object.entries(expected)) expect(actual[code]??'0').toBe(amount);
  }
  async function fingerprint(f:Capture) {
    const [row]=await database.sql`select
      (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t where merchant_id=${f.merchantId}) as journals,
      (select jsonb_agg(to_jsonb(e) order by e.id) from ledger_entries e join ledger_transactions t on t.id=e.transaction_id where t.merchant_id=${f.merchantId}) as entries`;
    return row;
  }
  // Verified settlement evidence fixture; it does not call or alter legacy
  // settlement writers. B2.4 must implement the runtime finalization protocol.
  async function settle(f:Capture) {
    await database.transaction(async (tx) => {
      const [lot]=await tx<{allocation_revision:string}[]>`select allocation_revision from capture_accounting_lots where id=${f.lotId} for update`;
      const [s]=await tx<{id:string}[]>`insert into settlements (merchant_id,currency,gross_amount,fee_amount,net_amount,available_on,accounting_policy_version,estimated_asset_transfer,estimated_merchant_release)
        values (${f.merchantId},'USD',${f.gross},${f.fee},${f.gross-f.fee},now(),'CAPTURE_FIFO_V1',${f.gross},${f.gross-f.fee}) returning id`;
      const [i]=await tx<{id:string}[]>`insert into settlement_items (settlement_id,payment_id,capture_attempt_id,gross_amount,fee_amount,net_amount,currency,capture_lot_id,accounting_policy_version,estimated_asset_transfer,estimated_merchant_release,selected_revision)
        values (${s.id},${f.paymentId},${f.attemptId},${f.gross},${f.fee},${f.gross-f.fee},'USD',${f.lotId},'CAPTURE_FIFO_V1',${f.gross},${f.gross-f.fee},${lot.allocation_revision}) returning id`;
      const journal=await ledger.post(tx,{merchantId:f.merchantId,businessType:'SETTLEMENT',businessId:s.id,currency:'USD',description:'B2.2 finalized fixture',lines:[
        {accountCode:'PLATFORM_CASH',merchantId:null,debit:f.gross},{accountCode:'PSP_CLEARING',merchantId:null,credit:f.gross},
        {accountCode:'MERCHANT_PENDING',merchantId:f.merchantId,debit:f.gross-f.fee},{accountCode:'MERCHANT_AVAILABLE',merchantId:f.merchantId,credit:f.gross-f.fee},
      ]});
      await tx`update settlement_items set finalized_asset_transfer=${f.gross},finalized_merchant_release=${f.gross-f.fee},restricted_hold=0,applied_revision=${lot.allocation_revision},finalization_result='POSTED',accounting_journal_id=${journal},accounting_finalized_at=now() where id=${i.id}`;
      await tx`update capture_accounting_lots set settlement_state='FINALIZED',finalized_settlement_item_id=${i.id} where id=${f.lotId}`;
      await tx`update settlements set status='SUCCEEDED',finalized_asset_transfer=${f.gross},finalized_merchant_release=${f.gross-f.fee},finalization_result='POSTED',accounting_journal_id=${journal},accounting_finalized_at=now() where id=${s.id}`;
    });
  }
  async function allocatedDispute(f:Capture,gross:number,hold:number) {
    return database.transaction(async tx=>{
      const [d]=await tx<{id:string}[]>`insert into disputes (merchant_id,payment_id,provider_dispute_id,status,amount,currency,opened_at)
        values (${f.merchantId},${f.paymentId},${`dp_${randomUUID()}`},'OPEN',${gross},'USD',now()) returning id`;
      const journal=hold ? await ledger.post(tx,{merchantId:f.merchantId,businessType:'DISPUTE_OPEN',businessId:d.id,currency:'USD',description:'Verified hold fixture',lines:[
        {accountCode:'MERCHANT_PENDING',merchantId:f.merchantId,debit:hold},{accountCode:'DISPUTE_CLEARING',merchantId:f.merchantId,credit:hold},
      ]}):null;
      await tx`insert into dispute_capture_allocations (dispute_id,capture_lot_id,payment_id,merchant_id,currency,gross_principal,funded_hold,unfunded_exposure,status,open_journal_id)
        values (${d.id},${f.lotId},${f.paymentId},${f.merchantId},'USD',${gross},${hold},${gross-hold},${hold?'OPEN':'PLANNED'},${journal})`;
      return d.id;
    });
  }
  function signal() { let resolve!:()=>void; const promise=new Promise<void>((done) => {resolve=done;}); return {promise,resolve}; }
  async function barrier(promise:Promise<void>) {
    let timer!:ReturnType<typeof setTimeout>;
    try { await Promise.race([promise,new Promise<never>((_,reject) => {timer=setTimeout(() => reject(new Error('Barrier timeout')),5000);})]); }
    finally { clearTimeout(timer); }
  }
  async function blocked(pid:number,owner:number) {
    const until=Date.now()+5000;
    while (Date.now()<until) {
      const [row]=await database.sql`select ${owner}=any(pg_blocking_pids(${pid})) as waiting`;
      if (row.waiting) return;
      await new Promise((done) => setTimeout(done,10));
    }
    throw new Error('Expected database lock wait was not observed');
  }
  // Owner holds the actual financial key. Observe the wait in PostgreSQL before
  // letting owner commit; no sleep is used as evidence of serialization.
  async function serial(f:Capture,first:(tx:DbTransaction)=>Promise<unknown>,second:()=>Promise<unknown>) {
    const held=signal(); const release=signal(); let owner=0;
    const a=database.transaction(async (tx) => {
      await tx`set local statement_timeout='10s'`;
      const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; owner=pid.pid;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${f.merchantId}:USD`},0))`;
      const result=await first(tx); held.resolve(); await barrier(release.promise); return result;
    });
    const checked=a.then(value=>({value}),error=>({error:asError(error)}));
    let b:Promise<{value:unknown}|{error:Error}>|undefined; let problem:Error|undefined;
    try {
      await barrier(held.promise); b=second().then(value=>({value}),error=>({error:asError(error)}));
      const until=Date.now()+5000; let observed=false;
      while (Date.now()<until) {
        const waiters=await database.sql<{pid:number}[]>`select pid from pg_stat_activity where datname=current_database() and ${owner}=any(pg_blocking_pids(pid))`;
        if (waiters.length) {await blocked(waiters[0].pid,owner); observed=true; break;}
        await new Promise((done) => setTimeout(done,10));
      }
      expect(observed).toBe(true);
    } catch (error) {problem=asError(error);} finally { release.resolve(); }
    const [result,other]=await Promise.all([checked,b]);
    if (problem) throw problem;
    if ('error' in result) throw result.error;
    if (other && 'error' in other) throw other.error;
    return other?.value;
  }

  it('fails closed for the real service on a dormant scope; legacy requests create no allocations', async () => {
    const f=await capture(); const real=new CaptureRefundAccountingService(database,idempotency,outbox,audit,ledger);
    await expect(real.create(actor(f),f.paymentId,randomUUID(),{amount:100})).rejects.toMatchObject({code:'ACCOUNTING_SCOPE_INACTIVE'});
    const legacy=new RefundsService(database,idempotency,outbox,audit,ledger);
    const r=(await legacy.create(actor(f),f.paymentId,randomUUID(),{amount:100})).value.id as string;
    expect(await allocations(r)).toHaveLength(0);
    const [scope]=await database.sql`select status from capture_accounting_scopes where merchant_id=${f.merchantId}`;
    expect(scope.status).toBe('FOUNDATION_ONLY');
  });
  it('reserves one capture atomically with audit/outbox/idempotent response and no liability hold', async () => {
    const f=await capture(); const key=randomUUID(); const a=await service.create(actor(f),f.paymentId,key,{amount:5000});
    const b=await service.create(actor(f),f.paymentId,key,{amount:5000});
    expect(b).toEqual({...a,replayed:true});
    expect(await allocations(a.value.id)).toMatchObject([{capture_lot_id:f.lotId,reserved_gross:'5000',status:'RESERVED',journal_id:null}]);
    await balances(f,{MERCHANT_PENDING:'9700',PLATFORM_FEE_REFUNDS:'0',PSP_CLEARING:'10000'});
    const [row]=await database.sql`select (select count(*)::integer from outbox_events where aggregate_id=${a.value.id}) as commands,
      (select count(*)::integer from audit_logs where action='refund.requested' and metadata->>'refundId'=${a.value.id}) as audits`;
    expect(row).toEqual({commands:1,audits:1});
    await expect(service.create(actor(f),f.paymentId,key,{amount:5001})).rejects.toMatchObject({code:'IDEMPOTENCY_PAYLOAD_MISMATCH'});
  });
  it('freezes FIFO across captures and uses one compatible provider reference', async () => {
    const a=await capture(4000,120); const b=await capture(6000,180,a); const r=await request(a,5000);
    const assigned=await allocations(r);
    expect(assigned).toHaveLength(2);
    expect(assigned.find(x=>x.capture_lot_id===a.lotId)?.reserved_gross).toBe('4000');
    expect(assigned.find(x=>x.capture_lot_id===b.lotId)?.reserved_gross).toBe('1000');
    const [command]=await database.sql`select payload from outbox_events where aggregate_id=${r}`;
    expect(command.payload).toMatchObject({providerPaymentId:`pi_${a.paymentId}`,idempotencyKey:`refund:${r}`,amount:5000});
    await capture(3000,90,a); expect(await allocations(r)).toEqual(assigned);
  });
  it('breaks identical financial timestamps by capture attempt ID', async () => {
    const merchantId=randomUUID(); const paymentId=randomUUID(); const attempts=[randomUUID(),randomUUID()];
    await database.sql`insert into merchants (id,name,fee_bps,settlement_delay_days) values (${merchantId},'Tie fixture',300,0)`;
    await database.sql`insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,captured_amount,platform_fee_amount,payment_method_token)
      values (${paymentId},${merchantId},'CAPTURED','MANUAL','USD',10000,10000,10000,300,'pm_test')`;
    await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${merchantId},'USD')`;
    // now() is transaction-stable: both genuine immutable journals have exactly
    // the same microsecond timestamp, without rewriting original evidence.
    const captures=await database.transaction(async tx=>{
      const fixtures:Capture[]=[];
      for (const [index,gross,fee] of [[0,4000,120],[1,6000,180]]) {
        const attemptId=attempts[index];
        await tx`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id)
          values (${attemptId},${merchantId},${paymentId},'CAPTURE','SUCCEEDED',${gross},'USD',${`pi_${paymentId}`})`;
        const journalId=await ledger.post(tx,{merchantId,businessType:'CAPTURE',businessId:attemptId,currency:'USD',description:'Tied capture fixture',lines:[
          {accountCode:'PSP_CLEARING',merchantId:null,debit:gross},{accountCode:'MERCHANT_PENDING',merchantId,credit:gross-fee},{accountCode:'PLATFORM_FEE_REVENUE',merchantId:null,credit:fee},
        ]});
        const [lot]=await tx<{id:string}[]>`insert into capture_accounting_lots (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at)
          select ${attemptId},${paymentId},${merchantId},'USD',id,${gross},${fee},${gross-fee},posted_at,posted_at from ledger_transactions where id=${journalId} returning id`;
        fixtures.push({merchantId,paymentId,attemptId,journalId,gross,fee,lotId:lot.id});
      }
      return fixtures;
    });
    const [times]=await database.sql`select count(distinct financial_captured_at)::integer as count from capture_accounting_lots where payment_id=${paymentId}`;
    expect(times.count).toBe(1);
    const r=await request(captures[0],1000); const [row]=await database.sql`select l.capture_attempt_id from refund_capture_allocations r join capture_accounting_lots l on l.id=r.capture_lot_id where refund_id=${r}`;
    expect(row.capture_attempt_id).toBe([...attempts].sort()[0]);
  });
  it.each(['different','missing','charge-only'])('rejects %s provider references with no partial intent, reservation or command', async (kind) => {
    const a=await capture(4000,120); const b=await capture(6000,180,a);
    if (kind==='charge-only') await database.sql`update payment_attempts set provider_transaction_id='ch_unsupported' where payment_id=${a.paymentId}`;
    else await database.sql`update payment_attempts set provider_transaction_id=${kind==='missing'?null:'pi_other'} where id=${b.attemptId}`;
    await expect(request(a,5000)).rejects.toMatchObject({code:'INCOMPATIBLE_CAPTURE_PROVIDER_REFERENCES'});
    const [row]=await database.sql`select (select count(*)::integer from refunds where payment_id=${a.paymentId}) as refunds,
      (select count(*)::integer from refund_capture_allocations where payment_id=${a.paymentId}) as allocations,
      (select count(*)::integer from outbox_events where aggregate_type='REFUND' and payload->>'paymentId'=${a.paymentId}) as commands`;
    expect(row).toEqual({refunds:0,allocations:0,commands:0});
  });
  it('rejects over-reservation and another merchant without committing idempotency intent', async () => {
    const f=await capture(); await request(f,7000);
    await expect(request(f,3001)).rejects.toMatchObject({code:'REFUND_CAPACITY_UNAVAILABLE'});
    const other=await capture(); await expect(service.create(actor(other),f.paymentId,randomUUID(),{amount:100})).rejects.toMatchObject({code:'PAYMENT_NOT_FOUND'});
    const [row]=await database.sql`select sum(reserved_gross)::text as gross from refund_capture_allocations where payment_id=${f.paymentId}`;
    expect(row.gross).toBe('7000');
  });
  it.each(['payment','merchant'])('rejects confirmed evidence with mismatched %s without financial changes', async (dimension) => {
    const f=await capture(); const other=await capture(); const r=await request(f,100); const before=await fingerprint(f);
    const id=await evidence(f,r,100,'refund.succeeded',dimension==='payment'?{paymentId:other.paymentId}:{merchantId:other.merchantId});
    await expect(apply(id)).rejects.toThrow(); expect(await fingerprint(f)).toEqual(before);
    expect((await allocations(r))[0].status).toBe('RESERVED');
    const [inbox]=await database.sql`select status from webhook_events where id=${id}`; expect(inbox.status).toBe('IGNORED');
  });
  it.each(['amount','currency'])('retains contradictory %s as accounting exception with no financial changes', async (dimension) => {
    const f=await capture(); const r=await request(f,100); const before=await fingerprint(f);
    const id=await evidence(f,r,dimension==='amount'?101:100,'refund.succeeded',dimension==='currency'?{currency:'EUR'}:{});
    expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    expect((await allocations(r))[0].status).toBe('RESERVED');
    expect(await state(f,r,id)).toMatchObject({journals:0,refund_status:'PENDING',inbox_status:'ACCOUNTING_EXCEPTION'});
  });
  it.each([5000,10000])('applies %i before settlement using only the capture pending contribution', async (amount) => {
    const f=await capture(); const r=await request(f,amount); const id=await succeeded(f,r,amount);
    const fee=amount*3/100;
    expect(await journalLines(r)).toEqual([
      {code:'MERCHANT_PENDING',debit:String(amount-fee),credit:'0'},
      {code:'PLATFORM_FEE_REFUNDS',debit:String(fee),credit:'0'},
      {code:'PSP_CLEARING',debit:'0',credit:String(amount)},
    ]);
    await balances(f,{MERCHANT_PENDING:String(9700-amount+fee),MERCHANT_AVAILABLE:'0',PSP_CLEARING:String(10000-amount),PLATFORM_CASH:'0',PLATFORM_FEE_REFUNDS:String(fee)});
    expect(await state(f,r,id)).toMatchObject({payment_status:amount===10000?'REFUNDED':'PARTIALLY_REFUNDED',refund_status:'SUCCEEDED',refunded_amount:String(amount),platform_fee_amount:String(fee),journals:1,success_audits:1,inbox_status:'PROCESSED'});
    const [a]=await allocations(r); expect(a).toMatchObject({status:'CONFIRMED',confirmed_gross:String(amount),confirmed_fee:String(fee),provider_event_id:id});
    const [j]=await database.sql`select id,status from ledger_transactions where business_type='REFUND' and business_id=${r}`;
    expect(a.journal_id).toBe(j.id); expect(j.status).toBe('POSTED');
  });
  it('uses available/cash after settlement without consuming another payment pending balance', async () => {
    const f=await capture(); await settle(f);
    const paymentId=randomUUID();
    await database.sql`insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,payment_method_token)
      values (${paymentId},${f.merchantId},'CAPTURED','MANUAL','USD',1,1,'pm_test')`;
    const other=await capture(2000,0,{merchantId:f.merchantId,paymentId});
    const r=await request(f,5000); await succeeded(f,r,5000);
    expect(await journalLines(r)).toEqual([{code:'MERCHANT_AVAILABLE',debit:'4850',credit:'0'},{code:'PLATFORM_CASH',debit:'0',credit:'5000'},{code:'PLATFORM_FEE_REFUNDS',debit:'150',credit:'0'}]);
    await balances(f,{MERCHANT_PENDING:'2000',MERCHANT_AVAILABLE:'4850',PSP_CLEARING:'2000',PLATFORM_CASH:'5000'});
    expect(other.paymentId).not.toBe(f.paymentId); expect(other.merchantId).toBe(f.merchantId);
  });
  it('splits the approved mixed-lot example into all five exact account legs', async () => {
    const a=await capture(4000,120); const b=await capture(6000,180,a); await settle(a);
    const r=await request(a,5000); await succeeded(a,r,5000);
    expect(await journalLines(r)).toEqual([
      {code:'MERCHANT_AVAILABLE',debit:'3880',credit:'0'},{code:'MERCHANT_PENDING',debit:'970',credit:'0'},
      {code:'PLATFORM_CASH',debit:'0',credit:'4000'},{code:'PLATFORM_FEE_REFUNDS',debit:'150',credit:'0'},{code:'PSP_CLEARING',debit:'0',credit:'1000'},
    ]);
    await balances(a,{MERCHANT_AVAILABLE:'0',MERCHANT_PENDING:'4850',PLATFORM_CASH:'0',PSP_CLEARING:'5000',PLATFORM_FEE_REFUNDS:'150'});
    expect((await allocations(r)).find(x=>x.capture_lot_id===b.lotId)?.confirmed_fee).toBe('30');
  });
  it('reverses cumulative fee 101 as 33,34,34 and never repeats it on replay', async () => {
    const f=await capture(1000,101);
    for (const [gross,fee] of [[333,33],[333,34],[334,34]]) {
      const r=await request(f,gross); await succeeded(f,r,gross); const before=await fingerprint(f);
      const replay=await evidence(f,r,gross); expect(await apply(replay)).toBe('PROCESSED');
      expect((await allocations(r))[0].confirmed_fee).toBe(String(fee)); expect(await fingerprint(f)).toEqual(before);
      expect(await state(f,r,replay)).toMatchObject({journals:1,success_audits:1,inbox_status:'PROCESSED'});
    }
    await balances(f,{MERCHANT_PENDING:'0',PSP_CLEARING:'0',PLATFORM_FEE_REFUNDS:'101'});
  });
  it('uses original per-capture fixed fees even after merchant configuration changes', async () => {
    const a=await capture(1000,100); await capture(1000,0,a);
    await database.sql`update merchants set fee_bps=9000,fixed_fee_minor=500 where id=${a.merchantId}`;
    const first=await request(a,1000); await succeeded(a,first,1000);
    const second=await request(a,1000); await succeeded(a,second,1000);
    expect((await allocations(first))[0].confirmed_fee).toBe('100'); expect((await allocations(second))[0].confirmed_fee).toBe('0');
    await balances(a,{MERCHANT_PENDING:'0',PSP_CLEARING:'0',PLATFORM_FEE_REFUNDS:'100'});
  });
  it.each([0,1000])('fully refunds capture fee %i without writing zero-valued ledger legs', async fee=>{
    const f=await capture(1000,fee); const r=await request(f,1000); await succeeded(f,r,1000);
    expect(await journalLines(r)).toEqual([
      {code:fee?'PLATFORM_FEE_REFUNDS':'MERCHANT_PENDING',debit:'1000',credit:'0'},
      {code:'PSP_CLEARING',debit:'0',credit:'1000'},
    ]);
    await balances(f,{MERCHANT_PENDING:'0',PSP_CLEARING:'0',PLATFORM_FEE_REFUNDS:String(fee)});
  });
  it('keeps fee products beyond safe Number precision exact with safe final ledger amounts', async () => {
    const f=await capture(8000000000000000,7000000000000001); const amount=1000000000000001;
    const fee=7000000000000001n*BigInt(amount)/8000000000000000n;
    const r=await request(f,amount); await succeeded(f,r,amount);
    expect((await allocations(r))[0].confirmed_fee).toBe(fee.toString());
    await balances(f,{MERCHANT_PENDING:(999999999999999n-BigInt(amount)+fee).toString(),PLATFORM_FEE_REFUNDS:fee.toString(),PSP_CLEARING:(8000000000000000n-BigInt(amount)).toString()});
  });
  it('confirms out of request order while retaining assignments and exact cumulative totals', async () => {
    const f=await capture(1000,101); const a=await request(f,333); const b=await request(f,667); const frozen=await allocations(a);
    await succeeded(f,b,667); await succeeded(f,a,333);
    expect((await allocations(a))[0].capture_lot_id).toBe(frozen[0].capture_lot_id);
    expect((await allocations(b))[0].confirmed_fee).toBe('67'); expect((await allocations(a))[0].confirmed_fee).toBe('34');
    await balances(f,{MERCHANT_PENDING:'0',PSP_CLEARING:'0',PLATFORM_FEE_REFUNDS:'101'});
  });
  it('rolls back after journal creation and retries the same evidence without orphan money', async () => {
    const f=await capture(); const r=await request(f,5000); const id=await evidence(f,r,5000); const before=await fingerprint(f);
    const original=ledger.post.bind(ledger); const spy=jest.spyOn(ledger,'post').mockImplementation(async (tx,input) => {
      const result=await original(tx,input); if (input.businessType==='REFUND') throw new Error('Injected after REFUND posting'); return result;
    });
    try { await expect(apply(id)).rejects.toThrow('Injected after REFUND posting'); } finally {spy.mockRestore();}
    expect(await fingerprint(f)).toEqual(before); expect((await allocations(r))[0].status).toBe('RESERVED');
    expect(await state(f,r,id)).toMatchObject({refund_status:'PENDING',refunded_amount:'0',journals:0,success_audits:0,inbox_status:'IGNORED'});
    expect(await apply(id)).toBe('PROCESSED'); expect(await state(f,r,id)).toMatchObject({journals:1,refunded_amount:'5000'});
  });
  it('rolls back completed allocations, workflow, audit and inbox if the surrounding transaction fails', async () => {
    const f=await capture(); const r=await request(f,5000); const id=await evidence(f,r,5000); const before=await fingerprint(f);
    await expect(database.transaction(async tx=>{await service.applySucceeded(tx,id); throw new Error('Rollback business transaction');})).rejects.toThrow('Rollback business transaction');
    expect(await fingerprint(f)).toEqual(before); expect((await allocations(r))[0].status).toBe('RESERVED');
    expect(await state(f,r,id)).toMatchObject({refund_status:'PENDING',refunded_amount:'0',journals:0,success_audits:0,inbox_status:'IGNORED'});
    await apply(id);
  });
  it('releases only the confirmed failed reservation and leaves immutable history unchanged', async () => {
    const f=await capture(); const a=await request(f,6000); const b=await request(f,4000); const before=await fingerprint(f);
    const id=await evidence(f,a,6000,'refund.failed'); expect(await apply(id,true)).toBe('PROCESSED');
    expect((await allocations(a))[0].status).toBe('RELEASED'); expect((await allocations(b))[0].status).toBe('RESERVED');
    const duplicate=await evidence(f,a,6000,'refund.failed'); expect(await apply(duplicate,true)).toBe('PROCESSED');
    expect(await fingerprint(f)).toEqual(before); expect(await state(f,a,id)).toMatchObject({refund_status:'FAILED',refunded_amount:'0',journals:0,inbox_status:'PROCESSED'});
    await request(f,6000);
    await expect(database.sql`update refund_capture_allocations set status='RESERVED' where refund_id=${a}`).rejects.toThrow(/immutable/i);
  });
  it('retains reservations when the actual command handler receives an unknown provider outcome', async () => {
    const f=await capture(); const r=await request(f,7000);
    const provider={refund:jest.fn().mockRejectedValue(new UnknownProviderOutcomeError('Lost provider response'))} as unknown as PaymentProvider;
    const [command]=await database.sql<{id:string;event_type:ProviderCommandEventType;payload:Record<string,unknown>}[]>`select id,event_type,payload from outbox_events where aggregate_id=${r}`;
    const handler=new PaymentCommandHandlerService(database,provider);
    await expect(handler.execute({id:command.id,aggregateId:r,eventType:command.event_type,payload:command.payload,createdAt:new Date(0).toISOString(),correlationId:r})).rejects.toThrow('Lost provider response');
    expect((await allocations(r))[0].status).toBe('RESERVED'); expect(await state(f,r)).toMatchObject({refund_status:'PENDING',journals:0});
    await expect(request(f,3001)).rejects.toMatchObject({code:'REFUND_CAPACITY_UNAVAILABLE'});
  });
  it.each(['success-after-failure','failure-after-success'])('retains %s as one durable exception without changing financial history', async (order) => {
    const f=await capture(); const r=await request(f,5000); const failed=order==='success-after-failure';
    await apply(await evidence(f,r,5000,failed?'refund.failed':'refund.succeeded'),failed);
    const before=await fingerprint(f); const frozen=await allocations(r); const id=await evidence(f,r,5000,failed?'refund.succeeded':'refund.failed');
    expect(await apply(id,!failed)).toBe('ACCOUNTING_EXCEPTION'); expect(await apply(id,!failed)).toBe('ACCOUNTING_EXCEPTION');
    expect(await fingerprint(f)).toEqual(before); expect(await allocations(r)).toEqual(frozen);
    const [row]=await database.sql<{payload:ProviderEvent}[]>`select w.status,w.processed_at,w.payload,e.status as exception_status,e.refund_id,e.provider_event_id,
      (select count(*)::integer from accounting_exceptions where provider_event_id=w.id) as exceptions,
      (select count(*)::integer from accounting_exception_lots where exception_id=e.id) as lots,
      s.status as scope_status from webhook_events w join accounting_exceptions e on e.provider_event_id=w.id
      join capture_accounting_scopes s on s.merchant_id=e.merchant_id and s.currency=e.currency where w.id=${id}`;
    expect(row).toMatchObject({status:'ACCOUNTING_EXCEPTION',processed_at:null,exception_status:'OPEN',refund_id:r,provider_event_id:id,exceptions:1,lots:1,scope_status:'REVIEW_REQUIRED'});
    expect(row.payload.data?.refundId).toBe(r);
    await expect(request(f,100)).rejects.toMatchObject({code:'ACCOUNTING_REVIEW_REQUIRED'});
  });
  it.each(['refund-reference','amount','payment-intent'])('retains provider mirror %s mismatch for review without guessing a journal', async dimension=>{
    const f=await capture(); const r=await request(f,100);
    await database.sql`insert into provider_transactions (merchant_id,payment_id,refund_id,provider,provider_transaction_id,payment_intent_id,provider_idempotency_key,operation,status,amount,currency)
      values (${f.merchantId},${f.paymentId},${r},'STRIPE',${dimension==='refund-reference'?'re_other':`re_${r}`},${dimension==='payment-intent'?'pi_other':`pi_${f.paymentId}`},${`refund:${r}`},'REFUND','succeeded',${dimension==='amount'?101:100},'USD')`;
    const id=await evidence(f,r,100,'refund.succeeded',{paymentIntentId:`pi_${f.paymentId}`}); expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION');
    expect(await state(f,r,id)).toMatchObject({journals:0,refund_status:'PENDING',inbox_status:'ACCOUNTING_EXCEPTION'});
  });
  it('retains a confirmed PaymentIntent disagreement with frozen captures even before mirror bookkeeping', async () => {
    const f=await capture(); const r=await request(f,100);
    const id=await evidence(f,r,100,'refund.succeeded',{paymentIntentId:'pi_other'}); expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION');
    expect((await allocations(r))[0].status).toBe('RESERVED'); expect(await state(f,r,id)).toMatchObject({journals:0,inbox_status:'ACCOUNTING_EXCEPTION'});
  });
  describe('B2.2.1 provider identity consistency', () => {
    async function exceptionState(f:Capture,r:string,id:string) {
      const [row]=await database.sql<{status:string;processed_at:Date|null;payload:ProviderEvent;exceptions:number;evidence:unknown;lots:number;scope_status:string;refund_audits:number}[]>`select w.status,w.processed_at,w.payload,
        (select count(*)::integer from accounting_exceptions where provider_event_id=w.id) as exceptions,
        (select jsonb_agg(to_jsonb(e)) from accounting_exceptions e where provider_event_id=w.id) as evidence,
        (select count(*)::integer from accounting_exception_lots el join accounting_exceptions e on e.id=el.exception_id where e.provider_event_id=w.id) as lots,
        (select status from capture_accounting_scopes where merchant_id=${f.merchantId} and currency='USD') as scope_status,
        (select count(*)::integer from audit_logs where target_id=${f.paymentId}::text and metadata->>'refundId'=${r}) as refund_audits
        from webhook_events w where w.id=${id}`;
      return row;
    }
    it.each(['refund.succeeded','refund.failed'] as const)('retains %s with absent event PaymentIntent and contradictory trusted mirror', async type=>{
      const f=await capture(); const r=await request(f,100); const mirror=await refundMirror(f,r,'pi_conflict');
      const id=await evidenceWithoutPaymentIntent(f,r,100,type); const frozen=await allocations(r); const before=await fingerprint(f);
      const original=await exceptionState(f,r,id);
      for (let replay=0;replay<2;replay++) expect(await apply(id,type==='refund.failed')).toBe('ACCOUNTING_EXCEPTION');
      expect(await allocations(r)).toEqual(frozen); expect(await fingerprint(f)).toEqual(before);
      expect(await journalLines(r)).toEqual([]);
      expect(await state(f,r,id)).toMatchObject({refund_status:'PENDING',payment_status:'CAPTURED',refunded_amount:'0',platform_fee_amount:'0',journals:0,success_audits:0,inbox_status:'ACCOUNTING_EXCEPTION'});
      const result=await exceptionState(f,r,id);
      expect(result).toMatchObject({status:'ACCOUNTING_EXCEPTION',processed_at:null,exceptions:1,lots:1,scope_status:'REVIEW_REQUIRED',refund_audits:original.refund_audits,payload:original.payload,
        evidence:[{status:'OPEN',refund_id:r,provider_event_id:id,observed_conflict:{providerIdentity:{eventPaymentIntentId:null,
          mirrors:[{id:mirror,provider:'STRIPE',operation:'REFUND',refund_id:r,payment_id:f.paymentId,merchant_id:f.merchantId,provider_idempotency_key:`refund:${r}`,payment_intent_id:'pi_conflict'}],
          captures:[{captureLotId:f.lotId,captureAttemptId:f.attemptId,paymentIntentId:`pi_${f.paymentId}`}],
        }}}]});
      expect(result.payload.data).not.toHaveProperty('paymentIntentId');
      await expect(request(f,9901)).rejects.toMatchObject({code:'ACCOUNTING_REVIEW_REQUIRED'});
    });
    it.each(['refund.succeeded','refund.failed'] as const)('retains explicit contradictory %s identity against frozen capture', async type=>{
      const f=await capture(); const r=await request(f,100); const id=await evidence(f,r,100,type,{paymentIntentId:'pi_conflict'});
      const frozen=await allocations(r); const before=await fingerprint(f);
      expect(await apply(id,type==='refund.failed')).toBe('ACCOUNTING_EXCEPTION');
      expect(await allocations(r)).toEqual(frozen); expect(await fingerprint(f)).toEqual(before); expect(await journalLines(r)).toEqual([]);
      expect(await state(f,r,id)).toMatchObject({refund_status:'PENDING',refunded_amount:'0',journals:0,inbox_status:'ACCOUNTING_EXCEPTION'});
      expect(await exceptionState(f,r,id)).toMatchObject({exceptions:1,evidence:[{status:'OPEN',observed_conflict:{providerIdentity:{eventPaymentIntentId:'pi_conflict'}}}]});
    });
    it.each([
      ['refund.succeeded',false],['refund.failed',false],['refund.succeeded',true],['refund.failed',true],
    ] as const)('processes matching %s identity with explicit event reference=%s', async (type,explicit)=>{
      const f=await capture(); const r=await request(f,100); await refundMirror(f,r,`pi_${f.paymentId}`);
      const id=await (explicit?evidence(f,r,100,type):evidenceWithoutPaymentIntent(f,r,100,type));
      expect(await apply(id,type==='refund.failed')).toBe('PROCESSED');
      const failed=type==='refund.failed';
      expect(await state(f,r,id)).toMatchObject({refund_status:failed?'FAILED':'SUCCEEDED',refunded_amount:failed?'0':'100',journals:failed?0:1,success_audits:failed?0:1,inbox_status:'PROCESSED'});
      expect((await allocations(r))[0]).toMatchObject({status:failed?'RELEASED':'CONFIRMED',reserved_gross:'100',confirmed_gross:failed?null:'100',confirmed_fee:failed?null:'3',provider_event_id:id});
      expect(await journalLines(r)).toEqual(failed?[]:[{code:'MERCHANT_PENDING',debit:'97',credit:'0'},{code:'PLATFORM_FEE_REFUNDS',debit:'3',credit:'0'},{code:'PSP_CLEARING',debit:'0',credit:'100'}]);
      expect(await exceptionState(f,r,id)).toMatchObject({exceptions:0,evidence:null});
    });
    it.each(['refund.succeeded','refund.failed'] as const)('validates %s terminal replay identity before returning early', async type=>{
      const f=await capture(); const r=await request(f,100); await apply(await evidence(f,r,100,type),type==='refund.failed');
      await refundMirror(f,r,'pi_conflict'); const id=await evidenceWithoutPaymentIntent(f,r,100,type);
      const before=await fingerprint(f); const frozen=await allocations(r); const prior=await state(f,r);
      expect(await apply(id,type==='refund.failed')).toBe('ACCOUNTING_EXCEPTION');
      expect(await fingerprint(f)).toEqual(before); expect(await allocations(r)).toEqual(frozen); expect(await state(f,r)).toEqual(prior);
      expect(await exceptionState(f,r,id)).toMatchObject({exceptions:1,status:'ACCOUNTING_EXCEPTION'});
    });
    it.each(['refund.succeeded','refund.failed'] as const)('retains unresolved %s identity when both event and trusted mirror PaymentIntent are absent', async type=>{
      const f=await capture(); const r=await request(f,100); await refundMirror(f,r,null);
      const id=await evidenceWithoutPaymentIntent(f,r,100,type); const frozen=await allocations(r); const before=await fingerprint(f);
      expect(await apply(id,type==='refund.failed')).toBe('ACCOUNTING_EXCEPTION');
      expect(await allocations(r)).toEqual(frozen); expect(await fingerprint(f)).toEqual(before);
      expect(await state(f,r,id)).toMatchObject({refund_status:'PENDING',refunded_amount:'0',journals:0,inbox_status:'ACCOUNTING_EXCEPTION'});
      expect(await exceptionState(f,r,id)).toMatchObject({exceptions:1,evidence:[{observed_conflict:{reason:'Provider PaymentIntent relationship is unresolved'}}]});
    });
    it.each(['operation','idempotency-key'])('does not use a matching unrelated mirror %s as identity authority', async dimension=>{
      const f=await capture(); const r=await request(f,100);
      await refundMirror(f,r,`pi_${f.paymentId}`,dimension==='operation'?'CAPTURE':'REFUND',dimension==='operation'?`refund:${r}`:`unrelated:${r}`);
      const id=await evidenceWithoutPaymentIntent(f,r,100,'refund.succeeded');
      expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION');
      expect(await state(f,r,id)).toMatchObject({refund_status:'PENDING',journals:0,inbox_status:'ACCOUNTING_EXCEPTION'});
      expect((await allocations(r))[0].status).toBe('RESERVED');
      expect(await exceptionState(f,r,id)).toMatchObject({exceptions:1,evidence:[{observed_conflict:{providerIdentity:{mirrors:[]}}}]});
    });
    it('ignores unrelated conflicting records when a relevant matching refund mirror establishes identity', async ()=>{
      const f=await capture(); const r=await request(f,100); await refundMirror(f,r,`pi_${f.paymentId}`);
      await refundMirror(f,r,'pi_unrelated','CAPTURE',`unrelated:${r}`);
      const id=await evidenceWithoutPaymentIntent(f,r,100,'refund.succeeded');
      expect(await apply(id)).toBe('PROCESSED'); expect(await state(f,r,id)).toMatchObject({journals:1,refunded_amount:'100'});
    });
    it.each(['refund.succeeded','refund.failed'] as const)('rolls back %s exception disposition on operational failure, retains original evidence and commits it on retry', async type=>{
      const f=await capture(); const r=await request(f,100); await refundMirror(f,r,'pi_conflict');
      const id=await evidenceWithoutPaymentIntent(f,r,100,type); const original=await exceptionState(f,r,id); const frozen=await allocations(r); const before=await fingerprint(f);
      await expect(database.transaction(async tx=>{
        expect(await (type==='refund.failed'?service.applyFailed(tx,id):service.applySucceeded(tx,id))).toBe('ACCOUNTING_EXCEPTION');
        const [pending]=await tx`select status,(select count(*)::integer from accounting_exceptions where provider_event_id=${id}) as exceptions from webhook_events where id=${id}`;
        expect(pending).toMatchObject({status:'ACCOUNTING_EXCEPTION',exceptions:1});
        throw new Error('Injected after exception disposition');
      })).rejects.toThrow('Injected after exception disposition');
      expect(await exceptionState(f,r,id)).toEqual(original); expect(await fingerprint(f)).toEqual(before); expect(await allocations(r)).toEqual(frozen);
      expect(await state(f,r,id)).toMatchObject({refund_status:'PENDING',refunded_amount:'0',journals:0,inbox_status:'IGNORED'});
      expect(await apply(id,type==='refund.failed')).toBe('ACCOUNTING_EXCEPTION');
      expect(await exceptionState(f,r,id)).toMatchObject({exceptions:1,status:'ACCOUNTING_EXCEPTION',payload:original.payload});
      expect(await fingerprint(f)).toEqual(before); expect(await allocations(r)).toEqual(frozen);
    });
  });
  it('preserves refund/dispute references and raw evidence when legacy dispute activity appears after acceptance', async () => {
    const f=await capture(); const r=await request(f,5000);
    const [d]=await database.sql<{id:string}[]>`insert into disputes (merchant_id,payment_id,provider_dispute_id,status,amount,currency,opened_at)
      values (${f.merchantId},${f.paymentId},${`dp_${randomUUID()}`},'OPEN',1000,'USD',now()) returning id`;
    const before=await fingerprint(f); const id=await evidence(f,r,5000);
    const [raw]=await database.sql<{payload:ProviderEvent}[]>`select payload from webhook_events where id=${id}`;
    expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    expect((await allocations(r))[0].status).toBe('RESERVED');
    const [row]=await database.sql<{observed_conflict:{disputes:unknown[]}}[]>`select e.refund_id,e.dispute_id,e.observed_conflict,w.payload,w.status from accounting_exceptions e join webhook_events w on w.id=e.provider_event_id where w.id=${id}`;
    expect(row).toMatchObject({refund_id:r,dispute_id:d.id,payload:raw.payload,status:'ACCOUNTING_EXCEPTION'});
    expect(row.observed_conflict.disputes).toHaveLength(1);
    const [claim]=await database.sql`select count(*)::integer as count from webhook_events where id=${id} and status in ('PENDING','RETRY','PROCESSING')`;
    expect(claim.count).toBe(0);
  });
  it('rejects unallocated legacy refund, dispute and settlement histories before external dispatch', async () => {
    for (const history of ['refund','dispute','settlement']) {
      const f=await capture();
      if (history==='refund') await database.sql`insert into refunds (merchant_id,payment_id,amount,currency) values (${f.merchantId},${f.paymentId},100,'USD')`;
      if (history==='dispute') await database.sql`insert into disputes (merchant_id,payment_id,provider_dispute_id,status,amount,currency,opened_at) values (${f.merchantId},${f.paymentId},${randomUUID()},'OPEN',100,'USD',now())`;
      if (history==='settlement') {
        const [s]=await database.sql<{id:string}[]>`insert into settlements (merchant_id,currency,gross_amount,fee_amount,net_amount,available_on) values (${f.merchantId},'USD',10000,300,9700,now()) returning id`;
        await database.sql`insert into settlement_items (settlement_id,payment_id,capture_attempt_id,gross_amount,fee_amount,net_amount,currency) values (${s.id},${f.paymentId},${f.attemptId},10000,300,9700,'USD')`;
      }
      await expect(request(f,100)).rejects.toMatchObject({code:'ACCOUNTING_REVIEW_REQUIRED'});
      const [row]=await database.sql`select count(*)::integer as count from outbox_events where payload->>'paymentId'=${f.paymentId}`; expect(row.count).toBe(0);
    }
  });
  it('retains confirmed evidence in unsupported payment state instead of silently losing it', async () => {
    const f=await capture(); const r=await request(f,5000); await database.sql`update payments set status='CAPTURE_PENDING' where id=${f.paymentId}`;
    const id=await evidence(f,r,5000); expect(await apply(id)).toBe('ACCOUNTING_EXCEPTION');
    expect(await state(f,r,id)).toMatchObject({journals:0,refunded_amount:'0',inbox_status:'ACCOUNTING_EXCEPTION'});
    expect((await allocations(r))[0].status).toBe('RESERVED');
  });
  it('subtracts active dispute principal from refundable capacity and preserves its funded hold', async () => {
    const f=await capture(); await allocatedDispute(f,1000,1000);
    await expect(request(f,9001)).rejects.toMatchObject({code:'REFUND_CAPACITY_UNAVAILABLE'});
    const r=await request(f,7000); await succeeded(f,r,7000);
    await balances(f,{MERCHANT_PENDING:'1910',DISPUTE_CLEARING:'1000',PLATFORM_FEE_REFUNDS:'210',PSP_CLEARING:'3000'});
    const [d]=await database.sql`select funded_hold::text as hold,status from dispute_capture_allocations where payment_id=${f.paymentId}`;
    expect(d).toEqual({hold:'1000',status:'OPEN'});
  });
  it('B2.3 adjusts funded holds before confirming a disjoint refund', async () => {
    const f=await capture(1000,800); await allocatedDispute(f,100,100);
    const r=await request(f,900); const id=await evidence(f,r,900);
    expect(await apply(id)).toBe('PROCESSED'); expect(await apply(id)).toBe('PROCESSED');
    const effects=await database.sql`select hold_delta::text,cause_refund_id,provider_event_id from dispute_hold_effects where payment_id=${f.paymentId}`;
    expect(effects).toEqual([{hold_delta:'-80',cause_refund_id:r,provider_event_id:id}]);
    expect((await allocations(r))[0].status).toBe('CONFIRMED');
    await balances(f,{MERCHANT_PENDING:'0',DISPUTE_CLEARING:'20',PLATFORM_FEE_REFUNDS:'720',PSP_CLEARING:'100'});
  });
  it('subtracts finalized loss principal and debits explained debt rather than creating negative pending', async () => {
    const f=await capture(1000,900); const dispute=await allocatedDispute(f,900,100);
    // Synthetic verified B1 close evidence, not a change to DisputesService.
    await database.transaction(async tx=>{
      const journal=await ledger.post(tx,{merchantId:f.merchantId,businessType:'DISPUTE_CLOSE',businessId:dispute,currency:'USD',description:'Final loss fixture',lines:[
        {accountCode:'DISPUTE_CLEARING',merchantId:f.merchantId,debit:100},{accountCode:'MERCHANT_AVAILABLE',merchantId:f.merchantId,debit:800},{accountCode:'PSP_CLEARING',merchantId:null,credit:900},
      ]});
      await tx`update dispute_capture_allocations set status='CLOSED',outcome='MERCHANT_LOST',close_journal_id=${journal} where dispute_id=${dispute}`;
      await tx`update disputes set status='CLOSED',outcome='MERCHANT_LOST',closed_at=now() where id=${dispute}`;
    });
    await expect(request(f,101)).rejects.toMatchObject({code:'REFUND_CAPACITY_UNAVAILABLE'});
    const r=await request(f,100); await succeeded(f,r,100);
    expect(await journalLines(r)).toEqual([{code:'MERCHANT_AVAILABLE',debit:'10',credit:'0'},{code:'PLATFORM_FEE_REFUNDS',debit:'90',credit:'0'},{code:'PSP_CLEARING',debit:'0',credit:'100'}]);
    await balances(f,{MERCHANT_PENDING:'0',MERCHANT_AVAILABLE:'-810',PSP_CLEARING:'0',DISPUTE_CLEARING:'0',PLATFORM_FEE_REFUNDS:'90'});
  });
  it('refuses legacy original-only eligibility even when the journal itself is canonical', async () => {
    const f=await captureFixture(database);
    await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD')`;
    const [l]=await database.sql<{id:string}[]>`insert into capture_accounting_lots (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,origin)
      select ${f.attemptId},${f.paymentId},${f.merchantId},'USD',id,10000,300,9700,posted_at,'LEGACY_ORIGINAL_ONLY' from ledger_transactions where id=${f.journalId} returning id`;
    await expect(request({...f,lotId:l.id},100)).rejects.toMatchObject({code:'ACCOUNTING_REVIEW_REQUIRED'});
  });
  it('does not release a reservation when an unfinalized intent already has financial journal evidence', async () => {
    const f=await capture(); const r=await request(f,100);
    await database.transaction(tx=>ledger.post(tx,{merchantId:f.merchantId,businessType:'REFUND',businessId:r,currency:'USD',description:'Inconsistent old effect fixture',lines:[
      {accountCode:'MERCHANT_PENDING',merchantId:f.merchantId,debit:97},{accountCode:'PLATFORM_FEE_REFUNDS',merchantId:null,debit:3},{accountCode:'PSP_CLEARING',merchantId:null,credit:100},
    ]}));
    const before=await fingerprint(f); const id=await evidence(f,r,100,'refund.failed');
    expect(await apply(id,true)).toBe('ACCOUNTING_EXCEPTION'); expect(await fingerprint(f)).toEqual(before);
    expect((await allocations(r))[0].status).toBe('RESERVED'); expect(await state(f,r,id)).toMatchObject({refund_status:'PENDING',journals:1,inbox_status:'ACCOUNTING_EXCEPTION'});
  });
  it('preserves F02 sealing and finalized allocation immutability', async () => {
    const f=await capture(); const r=await request(f,100); await succeeded(f,r,100); const [a]=await allocations(r);
    await expect(database.sql`update ledger_entries set debit=debit where transaction_id=${a.journal_id}`).rejects.toThrow(/immutable/i);
    await expect(database.sql`delete from ledger_entries where transaction_id=${a.journal_id}`).rejects.toThrow(/immutable/i);
    await expect(database.sql`update refund_capture_allocations set confirmed_fee=confirmed_fee where refund_id=${r}`).rejects.toThrow(/immutable/i);
    await expect(database.sql`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) select transaction_id,account_id,currency,debit,credit from ledger_entries where transaction_id=${a.journal_id} limit 1`).rejects.toThrow(/draft/i);
  });
  it('serializes competing requests and rejects the second over-capacity request after the first commits', async () => {
    const f=await capture(); const held=signal(); const release=signal(); let owner=0;
    const original=outbox.add.bind(outbox); const spy=jest.spyOn(outbox,'add').mockImplementation(async(tx,input)=>{
      const result=await original(tx,input); const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; owner=pid.pid; held.resolve(); await barrier(release.promise); return result;
    });
    const first=request(f,7000); const checked=first.then(value=>({value}),error=>({error:asError(error)})); let second:Promise<unknown>|undefined; let problem:Error|undefined;
    try {
      await barrier(held.promise); spy.mockRestore(); second=request(f,4000).then(value=>({value}),error=>({error:asError(error)}));
      const until=Date.now()+5000; let observed=false;
      while(Date.now()<until) {const waits=await database.sql<{pid:number}[]>`select pid from pg_stat_activity where datname=current_database() and ${owner}=any(pg_blocking_pids(pid))`; if(waits.length){observed=true;break;} await new Promise(done=>setTimeout(done,10));}
      expect(observed).toBe(true);
    } catch (error) {problem=asError(error);} finally {spy.mockRestore();release.resolve();}
    const [a,b]=await Promise.all([checked,second]); if (problem) throw problem;
    expect(a).toHaveProperty('value'); expect(b).toMatchObject({error:{code:'REFUND_CAPACITY_UNAVAILABLE'}});
    const [row]=await database.sql`select sum(reserved_gross)::text as gross from refund_capture_allocations where payment_id=${f.paymentId}`; expect(row.gross).toBe('7000');
  });
  it('serializes two success callbacks for different refunds of the same payment', async () => {
    const f=await capture(1000,101); const a=await request(f,333); const b=await request(f,667);
    const ea=await evidence(f,a,333); const eb=await evidence(f,b,667);
    expect(await serial(f,tx=>service.applySucceeded(tx,ea),()=>apply(eb))).toBe('PROCESSED');
    expect(await state(f,a)).toMatchObject({refunded_amount:'1000',journals:1}); expect(await state(f,b)).toMatchObject({journals:1});
    await balances(f,{MERCHANT_PENDING:'0',PSP_CLEARING:'0',PLATFORM_FEE_REFUNDS:'101'});
  });
  it('serializes concurrent duplicate success evidence into exactly one journal and audit', async () => {
    const f=await capture(); const r=await request(f,5000); const a=await evidence(f,r,5000); const b=await evidence(f,r,5000);
    expect(await serial(f,tx=>service.applySucceeded(tx,a),()=>apply(b))).toBe('PROCESSED');
    expect(await state(f,r,b)).toMatchObject({journals:1,success_audits:1,refunded_amount:'5000',inbox_status:'PROCESSED'});
  });
  it('serializes refund success after actual capture success without retargeting accepted lots', async () => {
    const f=await capture(); const r=await request(f,5000); const frozen=await allocations(r); const id=await evidence(f,r,5000);
    const attempt=randomUUID(); const provider=`pi_${f.paymentId}`;
    await database.sql`update payments set status='CAPTURE_PENDING',amount=12000,authorized_amount=12000 where id=${f.paymentId}`;
    await database.sql`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id) values (${attempt},${f.merchantId},${f.paymentId},'CAPTURE','PROCESSING',2000,'USD',${provider})`;
    const legacy=new RefundsService(database,idempotency,outbox,audit,ledger);
    const business=new WebhookBusinessService(ledger,outbox,audit,legacy,new DisputesService(ledger,audit));
    const e:ProviderEvent={id:`evt_${randomUUID()}`,type:'payment.capture_succeeded',externalType:'payment_intent.succeeded',createdAt:new Date(0).toISOString(),data:{merchantId:f.merchantId,paymentId:f.paymentId,attemptId:attempt,providerTransactionId:provider,amount:2000,currency:'USD'}};
    expect(await serial(f,tx=>business.handle(tx,e),()=>apply(id))).toBe('PROCESSED');
    expect(await state(f,r)).toMatchObject({captured_amount:'12000',refunded_amount:'5000',journals:1});
    expect((await allocations(r))[0].capture_lot_id).toBe(frozen[0].capture_lot_id);
    const [count]=await database.sql`select count(*)::integer as count from capture_accounting_lots where payment_id=${f.paymentId}`; expect(count.count).toBe(2);
    await balances(f,{MERCHANT_PENDING:'6790',PSP_CLEARING:'7000',PLATFORM_FEE_REFUNDS:'150'});
  });
  it('shares the payout key; a payout committed first permits explained available debt without pending theft', async () => {
    const f=await capture(); await settle(f); const r=await request(f,5000); const id=await evidence(f,r,5000);
    const held=signal(); const release=signal(); let owner=0; let payoutId='';
    const original=audit.append.bind(audit); const spy=jest.spyOn(audit,'append').mockImplementation(async(tx,input)=>{
      await original(tx,input); if(input.action==='payout.requested'){payoutId=input.targetId; const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`;owner=pid.pid;held.resolve();await barrier(release.promise);}
    });
    const first=payouts.request(actor(f),randomUUID(),{amount:9700,currency:'USD',destinationToken:'bank_test'});
    const checked=first.then(value=>({value}),error=>({error:asError(error)})); let refund:Promise<unknown>|undefined; let problem:Error|undefined;
    try {
      await barrier(held.promise); refund=apply(id).then(value=>({value}),error=>({error:asError(error)}));
      const until=Date.now()+5000;let observed=false;
      while(Date.now()<until){const waits=await database.sql<{pid:number}[]>`select pid from pg_stat_activity where datname=current_database() and ${owner}=any(pg_blocking_pids(pid))`;if(waits.length){observed=true;break;}await new Promise(done=>setTimeout(done,10));}
      expect(observed).toBe(true);
    } catch (error) {problem=asError(error);} finally {spy.mockRestore();release.resolve();}
    const [payout,confirmed]=await Promise.all([checked,refund]); if (problem) throw problem;
    expect(payout).toHaveProperty('value'); expect(confirmed).toEqual({value:'PROCESSED'});
    await database.transaction(tx=>payouts.complete(tx,payoutId));
    await balances(f,{MERCHANT_AVAILABLE:'-4850',MERCHANT_PENDING:'0',PAYOUT_CLEARING:'0',PLATFORM_CASH:'-4700',PSP_CLEARING:'0'});
    await expect(payouts.request(actor(f),randomUUID(),{amount:1,currency:'USD',destinationToken:'bank_test'})).rejects.toMatchObject({code:'INSUFFICIENT_AVAILABLE_BALANCE'});
  });
});
