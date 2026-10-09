import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DatabaseService } from '../../src/database/database.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { PaymentCommandHandlerService } from '../../src/payment-commands/payment-command-handler.service';
import { type PaymentProvider, UnknownProviderOutcomeError } from '../../src/payment-provider/payment-provider.types';
import { RefundsService } from '../../src/refunds/refunds.service';
import { SettlementsService } from '../../src/settlements/settlements.service';
import { WebhookBusinessService } from '../../src/webhooks/webhook-business.service';
import { WebhookProcessorService } from '../../src/webhooks/webhook-processor.service';
import { WebhookReceiverService } from '../../src/webhooks/webhook-receiver.service';
import type { ProviderEvent } from '../../src/webhooks/webhook.types';
import { captureFixture } from '../support/accounting-fixtures';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Capture = { merchantId: string; paymentId: string; attemptId: string; providerId: string; amount: number; currency: string };
interface CaptureLot { id: string; capture_journal_id: string; original_gross: string; original_fee: string; original_net: string }

describeDatabase('B2.1 capture journals and dormant accounting lots', () => {
  let database: DatabaseService; let ledger: LedgerService; let business: WebhookBusinessService; let refunds: RefundsService;
  beforeAll(() => {
    database = new DatabaseService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
    ledger = new LedgerService(database);
    const audit = new AuditService(); const outbox = new OutboxService();
    refunds = new RefundsService(database,new IdempotencyService(database),outbox,audit,ledger);
    business = new WebhookBusinessService(ledger,outbox,audit,refunds,new DisputesService(ledger,audit));
  });
  afterAll(async () => { await database.onApplicationShutdown(); });

  async function capture(amount = 10000, options: { feeBps?: number; fixedFee?: number; delay?: number; currency?: string } = {}): Promise<Capture> {
    const f = { merchantId:randomUUID(),paymentId:randomUUID(),attemptId:randomUUID(),providerId:`pi_${randomUUID()}`,amount,currency:options.currency ?? 'USD' };
    await database.sql`insert into merchants (id,name,fee_bps,fixed_fee_minor,settlement_delay_days)
      values (${f.merchantId},'B2.1 isolated capture',${options.feeBps ?? 300},${options.fixedFee ?? 0},${options.delay ?? 2})`;
    await database.sql`insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,payment_method_token)
      values (${f.paymentId},${f.merchantId},'CAPTURE_PENDING','MANUAL',${f.currency},${amount},${amount},'pm_test')`;
    await attempt(f);
    return f;
  }
  async function attempt(f: Capture) {
    await database.sql`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id)
      values (${f.attemptId},${f.merchantId},${f.paymentId},'CAPTURE','PROCESSING',${f.amount},${f.currency},${f.providerId})`;
    await database.sql`insert into provider_transactions
      (merchant_id,payment_id,payment_attempt_id,provider,provider_transaction_id,payment_intent_id,provider_idempotency_key,operation,status,amount,currency)
      values (${f.merchantId},${f.paymentId},${f.attemptId},'STRIPE',${f.providerId},${f.providerId},${`capture:${f.attemptId}`},'CAPTURE','processing',${f.amount},${f.currency})`;
  }
  function event(f: Capture): ProviderEvent {
    return { id:`evt_${randomUUID()}`,type:'payment.capture_succeeded',externalType:'payment_intent.succeeded',createdAt:new Date(0).toISOString(),
      data:{merchantId:f.merchantId,paymentId:f.paymentId,attemptId:f.attemptId,providerTransactionId:f.providerId,paymentIntentId:f.providerId,amount:f.amount,currency:f.currency,providerStatus:'succeeded'} };
  }
  const apply = (e: ProviderEvent) => database.transaction((tx) => business.handle(tx,e));
  async function state(f: Capture) {
    const [row] = await database.sql`select p.status,p.captured_amount::text,p.platform_fee_amount::text,p.version,a.status as attempt_status,
      (select count(*)::integer from ledger_transactions where business_type='CAPTURE' and business_id=a.id) as journals,
      (select count(*)::integer from capture_accounting_lots where capture_attempt_id=a.id) as lots,
      (select count(*)::integer from audit_logs where target_id=p.id::text and action='payment.capture_succeeded') as audits
      from payments p join payment_attempts a on a.payment_id=p.id where a.id=${f.attemptId}`;
    return row;
  }
  async function lot(f: Capture) {
    const [row] = await database.sql<CaptureLot[]>`select l.id,l.capture_journal_id,l.payment_id,l.merchant_id,l.currency,
      l.original_gross::text,l.original_fee::text,l.original_net::text,l.financial_captured_at::text,l.eligible_at::text,
      extract(epoch from (l.eligible_at-l.financial_captured_at))::integer as delay_seconds,
      l.financial_captured_at=t.posted_at as posting_time_matches,l.origin,l.allocation_revision::text,l.settlement_state,s.status as scope_status,
      t.status as journal_status,
      (select sum(e.debit)::text from ledger_entries e join ledger_accounts a on a.id=e.account_id where e.transaction_id=t.id and a.code='PSP_CLEARING') as journal_gross,
      (select coalesce(sum(e.credit),0)::text from ledger_entries e join ledger_accounts a on a.id=e.account_id where e.transaction_id=t.id and a.code='PLATFORM_FEE_REVENUE') as journal_fee,
      (select coalesce(sum(e.credit),0)::text from ledger_entries e join ledger_accounts a on a.id=e.account_id where e.transaction_id=t.id and a.code='MERCHANT_PENDING') as journal_net
      from capture_accounting_lots l join ledger_transactions t on t.id=l.capture_journal_id
      join capture_accounting_scopes s on s.merchant_id=l.merchant_id and s.currency=l.currency where l.capture_attempt_id=${f.attemptId}`;
    return row;
  }
  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve=done; });
    return { promise,resolve };
  }
  async function blocked(pid: number, owner: number) {
    const until = Date.now()+4000;
    while (Date.now()<until) {
      const [row] = await database.sql<{ waiting: boolean }[]>`select ${owner}=any(pg_blocking_pids(${pid})) as waiting`;
      if (row.waiting) return;
      await new Promise((done) => setTimeout(done,10));
    }
    throw new Error('Expected PostgreSQL lock wait was not observed');
  }
  async function barrier(promise: Promise<void>) {
    let timeout!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([promise,new Promise<never>((_,reject) => {
        timeout=setTimeout(() => reject(new Error('Transaction barrier was not reached')),4000);
      })]);
    } finally { clearTimeout(timeout); }
  }

  it('commits exactly one journal, lot, state transition and audit for a confirmed capture', async () => {
    const f = await capture(); await apply(event(f));
    expect(await state(f)).toMatchObject({status:'CAPTURED',captured_amount:'10000',platform_fee_amount:'300',attempt_status:'SUCCEEDED',journals:1,lots:1,audits:1});
    expect(await lot(f)).toMatchObject({payment_id:f.paymentId,merchant_id:f.merchantId,currency:'USD',original_gross:'10000',original_fee:'300',original_net:'9700',
      journal_gross:'10000',journal_fee:'300',journal_net:'9700',journal_status:'POSTED',posting_time_matches:true,delay_seconds:172800,
      origin:'NEW_CAPTURE',allocation_revision:'0',settlement_state:'UNSETTLED',scope_status:'FOUNDATION_ONLY'});
  });
  it('keeps independent lots and actual cumulative fee deltas across partial captures', async () => {
    const f = await capture(10000,{feeBps:0,fixedFee:100});
    await database.sql`update payment_attempts set amount=4000 where id=${f.attemptId}`;
    f.amount=4000; await apply(event(f));
    const second = {...f,attemptId:randomUUID(),amount:6000}; await attempt(second);
    await database.sql`update payments set status='CAPTURE_PENDING' where id=${f.paymentId}`;
    await apply(event(second));
    const a = await lot(f); const b = await lot(second);
    expect(a).toMatchObject({original_gross:'4000',original_fee:'100',original_net:'3900',journal_fee:'100'});
    expect(b).toMatchObject({original_gross:'6000',original_fee:'0',original_net:'6000',journal_fee:'0'});
    expect(a.id).not.toBe(b.id); expect(a.capture_journal_id).not.toBe(b.capture_journal_id);
    const [totals] = await database.sql`select count(*)::integer as lots,sum(original_gross)::text as gross,sum(original_fee)::text as fee
      from capture_accounting_lots where payment_id=${f.paymentId}`;
    expect(totals).toEqual({lots:2,gross:'10000',fee:'100'});
  });
  it.each([0,10000])('preserves zero-value omitted journal legs with fee bps %i', async (feeBps) => {
    const f = await capture(1000,{feeBps}); await apply(event(f));
    const row = await lot(f); const fee=feeBps===0?'0':'1000'; const net=feeBps===0?'1000':'0';
    expect(row).toMatchObject({original_gross:'1000',original_fee:fee,original_net:net,journal_fee:fee,journal_net:net});
  });
  it('freezes exact posting time and eligibility across delivery, term and attempt timestamp changes', async () => {
    const f=await capture(); const e=event(f); await apply(e); const before=await lot(f); const paymentBefore=await state(f);
    await database.sql`update merchants set fee_bps=900,fixed_fee_minor=100,settlement_delay_days=9 where id=${f.merchantId}`;
    await database.sql`update payment_attempts set updated_at=now()+interval '30 days' where id=${f.attemptId}`;
    await apply(e); await apply({...e,id:`evt_${randomUUID()}`});
    expect(await lot(f)).toEqual(before); expect(await state(f)).toEqual(paymentBefore);
    const [mirror]=await database.sql`select provider_transaction_id,payment_intent_id,provider_idempotency_key from provider_transactions where payment_attempt_id=${f.attemptId}`;
    expect(mirror).toEqual({provider_transaction_id:f.providerId,payment_intent_id:f.providerId,provider_idempotency_key:`capture:${f.attemptId}`});
  });
  it('does not post or create a lot for confirmed capture failure', async () => {
    const f=await capture(); const e=event(f); e.type='payment.capture_failed'; await apply(e);
    expect(await state(f)).toMatchObject({status:'AUTHORIZED',captured_amount:'0',attempt_status:'FAILED',journals:0,lots:0,audits:0});
  });
  it('does not create a capture lot for authorization alone', async () => {
    const f=await capture(); await database.sql`update payment_attempts set kind='AUTHORIZE' where id=${f.attemptId}`;
    await database.sql`update payments set status='REQUIRES_AUTHORIZATION' where id=${f.paymentId}`;
    const e=event(f); e.type='payment.authorized'; await apply(e);
    expect(await state(f)).toMatchObject({status:'AUTHORIZED',captured_amount:'0',attempt_status:'SUCCEEDED',journals:0,lots:0,audits:0});
  });
  it('rejects an authorization attempt on the capture transaction path', async () => {
    const f=await capture(); await database.sql`update payment_attempts set kind='AUTHORIZE' where id=${f.attemptId}`;
    await expect(apply(event(f))).rejects.toThrow(/attempt is not visible/i);
    expect(await state(f)).toMatchObject({captured_amount:'0',attempt_status:'PROCESSING',journals:0,lots:0,audits:0});
  });
  it.each(['merchant','currency'] as const)('rejects a cross-%s attempt and rolls back the entire transaction', async (mismatch) => {
    const f=await capture(); const other=await capture(10000,{currency:mismatch==='currency'?'EUR':'USD'});
    const e=event(other); e.data!.attemptId=f.attemptId; e.data!.providerTransactionId=f.providerId; e.data!.paymentIntentId=f.providerId;
    const before=await state(other);
    await expect(apply(e)).rejects.toThrow(/identity does not match/i);
    expect(await state(other)).toEqual(before); expect(await state(f)).toMatchObject({journals:0,lots:0,audits:0});
    const [scope]=await database.sql`select count(*)::integer as count from capture_accounting_scopes where merchant_id=${other.merchantId}`;
    expect(scope.count).toBe(0);
  });
  it('rolls back a posted journal and workflow updates when lot creation fails, then safely retries', async () => {
    const f=await capture(); const e=event(f); const before=await state(f); let sawPosted=false;
    await expect(database.transaction(async (tx) => {
      const fault = new Proxy(tx,{apply(target,thisArg,args: [TemplateStringsArray,...unknown[]]) {
        if (args[0].join('?').includes('insert into public.capture_accounting_lots')) return (async () => {
          const [journal]=await tx`select status from ledger_transactions where business_type='CAPTURE' and business_id=${f.attemptId}`;
          sawPosted=journal?.status==='POSTED';
          throw new Error('Injected failure at lot creation');
        })();
        return Reflect.apply(target,thisArg,args) as unknown;
      }});
      await business.handle(fault,e);
    })).rejects.toThrow('Injected failure at lot creation');
    expect(sawPosted).toBe(true); expect(await state(f)).toEqual(before);
    const [scope]=await database.sql`select count(*)::integer as count from capture_accounting_scopes where merchant_id=${f.merchantId}`;
    const [mirror]=await database.sql`select status from provider_transactions where payment_attempt_id=${f.attemptId}`;
    expect(scope.count).toBe(0); expect(mirror.status).toBe('processing');
    await apply(e); expect(await state(f)).toMatchObject({journals:1,lots:1,audits:1,captured_amount:'10000'});
  });
  it.each([100,300])('refuses existing journal fee %i for an incomplete attempt without guessing historical eligibility', async (fee) => {
    const f=await capture();
    await database.transaction((tx) => ledger.post(tx,{merchantId:f.merchantId,businessType:'CAPTURE',businessId:f.attemptId,currency:'USD',description:'Retained inconsistent prerequisite fixture',lines:[
      {accountCode:'PSP_CLEARING',merchantId:null,debit:10000},{accountCode:'MERCHANT_PENDING',merchantId:f.merchantId,credit:10000-fee},{accountCode:'PLATFORM_FEE_REVENUE',merchantId:null,credit:fee},
    ]}));
    const before=await state(f); await expect(apply(event(f))).rejects.toThrow(/already has financial evidence/i);
    expect(await state(f)).toEqual(before); expect(await lot(f)).toBeUndefined();
  });
  it.each([false,true])('creates no financial effect from provider command execution (unknown outcome: %s)', async (unknown) => {
    const f=await capture(); const before=await state(f);
    const provider: PaymentProvider = {
      authorize:jest.fn(),refund:jest.fn(),cancel:jest.fn(),fetchStatus:jest.fn(),
      capture:() => unknown ? Promise.reject(new UnknownProviderOutcomeError('Local fixture unknown outcome'))
        : Promise.resolve({providerObjectId:f.providerId,paymentIntentId:f.providerId,status:'succeeded',metadata:{}}),
    };
    const executing=new PaymentCommandHandlerService(database,provider).execute({id:randomUUID(),aggregateId:f.attemptId,
      correlationId:f.attemptId,eventType:'provider.capture.requested',createdAt:new Date().toISOString(),
      payload:{merchantId:f.merchantId,paymentId:f.paymentId,attemptId:f.attemptId,amount:f.amount,currency:f.currency,providerPaymentId:f.providerId,idempotencyKey:`capture:${f.attemptId}`}});
    if (unknown) await expect(executing).rejects.toThrow('Local fixture unknown outcome'); else await executing;
    expect(await state(f)).toEqual(before); expect(await lot(f)).toBeUndefined();
  });
  it('rolls back the complete financial effect on a PostgreSQL lot constraint failure', async () => {
    const f=await capture(10000,{delay:-1}); const before=await state(f); const e=event(f);
    // The legacy merchant schema permits a negative delay; the lot must refuse it.
    await expect(apply(e)).rejects.toThrow(/check constraint/i);
    expect(await state(f)).toEqual(before);
    await database.sql`update merchants set settlement_delay_days=2 where id=${f.merchantId}`;
    await apply(e); expect(await state(f)).toMatchObject({journals:1,lots:1,audits:1});
  });
  it('preserves REVIEW_REQUIRED and its exception while recording new original capture evidence', async () => {
    const f=await capture();
    await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD')`;
    const [exception]=await database.sql<{id:string}[]>`insert into accounting_exceptions (merchant_id,currency,source_kind,category,evidence_key,observed_conflict)
      values (${f.merchantId},'USD','LEGACY','LEGACY_ALLOCATION_UNRECONCILED',${randomUUID()},'{}') returning *`;
    await apply(event(f)); expect(await lot(f)).toMatchObject({scope_status:'REVIEW_REQUIRED'});
    const [retained]=await database.sql`select * from accounting_exceptions where id=${exception.id}`;
    expect(retained).toEqual(exception);
  });
  it('does not backfill an old successful capture on duplicate delivery', async () => {
    const f=await captureFixture(database);
    await apply(event({...f,amount:f.gross,currency:'USD',providerId:`pi_${f.paymentId}`}));
    expect(await state({...f,amount:f.gross,currency:'USD',providerId:`pi_${f.paymentId}`})).toMatchObject({journals:1,lots:0,audits:0});
  });
  it('preserves unknown legacy eligibility while adding a new lot on the same payment', async () => {
    const old=await captureFixture(database); const f={...old,amount:old.gross,currency:'USD',providerId:`pi_${old.paymentId}`};
    await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD')`;
    await database.sql`insert into capture_accounting_lots
      (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,origin)
      select ${f.attemptId},${f.paymentId},${f.merchantId},'USD',id,10000,300,9700,posted_at,'LEGACY_ORIGINAL_ONLY'
      from ledger_transactions where id=${old.journalId}`;
    const before=await lot(f); await apply(event(f));
    const next={...f,attemptId:randomUUID(),amount:2000}; await attempt(next);
    await database.sql`update payments set status='CAPTURE_PENDING',amount=12000,authorized_amount=12000 where id=${f.paymentId}`;
    await apply(event(next)); expect(await lot(f)).toEqual(before);
    expect(before).toMatchObject({eligible_at:null,origin:'LEGACY_ORIGINAL_ONLY'});
    expect(await lot(next)).toMatchObject({original_gross:'2000',original_fee:'60',original_net:'1940',delay_seconds:0,scope_status:'FOUNDATION_ONLY'});
  });
  it('serializes concurrent duplicate success before either payment or attempt is locked', async () => {
    const f=await capture(); const firstReady=signal(); const release=signal(); const secondReady=signal(); let firstPid=0; let secondPid=0;
    const first=database.transaction(async (tx) => {
      const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; firstPid=pid.pid;
      await business.handle(tx,event(f)); firstReady.resolve(); await release.promise;
    });
    let second: Promise<void> | undefined;
    try {
      await firstReady.promise;
      second=database.transaction(async (tx) => {
        await tx`set local lock_timeout='6s'`;
        const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; secondPid=pid.pid; secondReady.resolve();
        await business.handle(tx,event(f));
      });
      await secondReady.promise; await blocked(secondPid,firstPid);
    } finally { release.resolve(); await Promise.all([first,second]); }
    expect(await state(f)).toMatchObject({journals:1,lots:1,audits:1,captured_amount:'10000'});
  });
  it('waits on the payout advisory key before writing the provider mirror', async () => {
    const f=await capture(); const ownerReady=signal(); const release=signal(); const captureReady=signal(); let ownerPid=0; let capturePid=0;
    const owner=database.transaction(async (tx) => {
      const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; ownerPid=pid.pid;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${f.merchantId}:${f.currency}`},0))`;
      ownerReady.resolve(); await release.promise;
    });
    let applying: Promise<void> | undefined;
    try {
      await ownerReady.promise;
      applying=database.transaction(async (tx) => {
        await tx`set local lock_timeout='6s'`;
        const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; capturePid=pid.pid; captureReady.resolve();
        await business.handle(tx,event(f));
      });
      await captureReady.promise; await blocked(capturePid,ownerPid);
      const [mirror]=await database.sql`select status from provider_transactions where payment_attempt_id=${f.attemptId}`;
      expect(mirror.status).toBe('processing'); expect(await state(f)).toMatchObject({journals:0,lots:0});
    } finally { release.resolve(); await Promise.all([owner,applying]); }
    expect(await state(f)).toMatchObject({journals:1,lots:1});
  });
  it('allows an existing payment-first writer to update the capture child while capture waits', async () => {
    const f=await capture(); const ownerReady=signal(); const release=signal(); const captureReady=signal(); let ownerPid=0; let capturePid=0;
    const owner=database.transaction(async (tx) => {
      await tx`set local lock_timeout='6s'`;
      const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; ownerPid=pid.pid;
      await tx`select id from payments where id=${f.paymentId} for update`;
      ownerReady.resolve(); await release.promise;
      await tx`update payment_attempts set updated_at=now() where id=${f.attemptId}`;
    });
    let applying: Promise<void> | undefined;
    try {
      await ownerReady.promise;
      applying=database.transaction(async (tx) => {
        await tx`set local lock_timeout='6s'`;
        const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; capturePid=pid.pid; captureReady.resolve();
        await business.handle(tx,event(f));
      });
      await captureReady.promise; await blocked(capturePid,ownerPid);
    } finally { release.resolve(); await Promise.all([owner,applying]); }
    expect(await state(f)).toMatchObject({journals:1,lots:1});
  });
  it.each(['settlement-first','capture-first'] as const)('allows settlement generation and duplicate captures without retries (%s)', async (order) => {
    const f=await capture(10000,{delay:0}); await apply(event(f));
    const before=await lot(f); const beforeState=await state(f);
    const entries=await database.sql`select * from ledger_entries where transaction_id=${before.capture_journal_id} order by id`;
    const selected=signal(); const insertAllowed=signal(); const paymentLocked=signal(); const attemptAllowed=signal(); const duplicateReady=signal();
    let generatorPid=0; let capturePid=0; let duplicatePid=0;
    let generating: Promise<string[]> | undefined; let replaying: Promise<void> | undefined; let duplicate: Promise<void> | undefined;
    let results: PromiseSettledResult<unknown>[]=[];
    const startGeneration=() => {
      const controlledDatabase=new Proxy(database,{get(target,property,receiver) {
        if (property!=='transaction') return Reflect.get(target,property,receiver) as unknown;
        return (work: Parameters<DatabaseService['transaction']>[0]) => target.transaction(async (tx) => {
          await tx`set local statement_timeout='8s'`;
          const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; generatorPid=pid.pid;
          const observed=new Proxy(tx,{apply(query,thisArg,args: [TemplateStringsArray,...unknown[]]) {
            if (args[0].join('?').includes('with eligible as materialized')) return (async () => {
              const rows: unknown=await Reflect.apply(query,thisArg,args);
              expect(rows).toHaveLength(1); selected.resolve(); await insertAllowed.promise; return rows;
            })();
            return Reflect.apply(query,thisArg,args) as unknown;
          }});
          return work(observed);
        });
      }});
      generating=new SettlementsService(controlledDatabase,ledger,new AuditService()).generate(f.merchantId);
      // Attach handlers before any barrier: a regression can abort either transaction.
      void generating.catch(() => undefined);
    };
    const startReplay=() => {
      replaying=database.transaction(async (tx) => {
        await tx`set local statement_timeout='8s'`;
        const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; capturePid=pid.pid;
        const observed=new Proxy(tx,{apply(query,thisArg,args: [TemplateStringsArray,...unknown[]]) {
          if (args[0].join('?').includes('from payments where id=')) return (async () => {
            const rows: unknown=await Reflect.apply(query,thisArg,args);
            paymentLocked.resolve(); await attemptAllowed.promise; return rows;
          })();
          return Reflect.apply(query,thisArg,args) as unknown;
        }});
        await business.handle(observed,event(f));
      });
      void replaying.catch(() => undefined);
    };
    try {
      if (order==='settlement-first') { startGeneration(); await barrier(selected.promise); startReplay(); }
      else { startReplay(); await barrier(paymentLocked.promise); startGeneration(); await barrier(selected.promise); }
      await barrier(paymentLocked.promise); attemptAllowed.resolve(); await blocked(capturePid,generatorPid);
      duplicate=database.transaction(async (tx) => {
        await tx`set local statement_timeout='8s'`;
        const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; duplicatePid=pid.pid; duplicateReady.resolve();
        await business.handle(tx,event(f));
      });
      void duplicate.catch(() => undefined);
      await barrier(duplicateReady.promise); await blocked(duplicatePid,capturePid);
    } finally {
      attemptAllowed.resolve(); insertAllowed.resolve();
      results=await Promise.allSettled([generating,replaying,duplicate]);
    }
    const outcomes=results.map((result) => result.status==='rejected'
      ? {status:result.status,code:(result.reason as {code?:string}).code} : {status:result.status});
    expect(outcomes).toEqual([{status:'fulfilled'},{status:'fulfilled'},{status:'fulfilled'}]);
    const batches=(results[0] as PromiseFulfilledResult<string[]>).value;
    expect(batches).toHaveLength(1);
    expect(await state(f)).toEqual(beforeState); expect(await lot(f)).toEqual(before);
    expect(await database.sql`select * from ledger_entries where transaction_id=${before.capture_journal_id} order by id`).toEqual(entries);
    const items=await database.sql`select i.payment_id,i.capture_attempt_id,i.currency,i.gross_amount::text,i.fee_amount::text,i.net_amount::text,
      s.merchant_id,s.status,s.gross_amount::text as batch_gross,s.fee_amount::text as batch_fee,s.net_amount::text as batch_net,
      l.id as lot_id,t.id as journal_id,t.status as journal_status
      from settlement_items i join settlements s on s.id=i.settlement_id
      join capture_accounting_lots l on l.capture_attempt_id=i.capture_attempt_id and l.payment_id=i.payment_id
      join ledger_transactions t on t.id=l.capture_journal_id
      where i.settlement_id=${batches[0]}`;
    expect(items).toEqual([expect.objectContaining({payment_id:f.paymentId,capture_attempt_id:f.attemptId,currency:f.currency,merchant_id:f.merchantId,
      gross_amount:'10000',fee_amount:'300',net_amount:'9700',batch_gross:'10000',batch_fee:'300',batch_net:'9700',status:'PENDING',
      lot_id:before.id,journal_id:before.capture_journal_id,journal_status:'POSTED'})]);
    const [count]=await database.sql`select count(*)::integer as items from settlement_items where capture_attempt_id=${f.attemptId}`;
    expect(count.items).toBe(1);
  },25000);
  it('serializes a refund writer while duplicate capture holds the payment lock', async () => {
    const f=await capture(); await apply(event(f)); const original=await lot(f); const refundId=randomUUID();
    await database.sql`insert into refunds (id,merchant_id,payment_id,status,amount,currency)
      values (${refundId},${f.merchantId},${f.paymentId},'PROCESSING',1000,${f.currency})`;
    const paymentLocked=signal(); const release=signal(); const writerReady=signal(); let capturePid=0; let writerPid=0;
    const replaying=database.transaction(async (tx) => {
      await tx`set local statement_timeout='8s'`;
      const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; capturePid=pid.pid;
      const observed=new Proxy(tx,{apply(query,thisArg,args: [TemplateStringsArray,...unknown[]]) {
        if (args[0].join('?').includes('from payments where id=')) return (async () => {
          const rows: unknown=await Reflect.apply(query,thisArg,args); paymentLocked.resolve(); await release.promise; return rows;
        })();
        return Reflect.apply(query,thisArg,args) as unknown;
      }});
      await business.handle(observed,event(f));
    });
    void replaying.catch(() => undefined);
    let writing: Promise<void> | undefined; let results: PromiseSettledResult<unknown>[]=[];
    try {
      await barrier(paymentLocked.promise);
      writing=database.transaction(async (tx) => {
        await tx`set local statement_timeout='8s'`;
        const [pid]=await tx<{pid:number}[]>`select pg_backend_pid() as pid`; writerPid=pid.pid; writerReady.resolve();
        await refunds.applySucceeded(tx,{merchantId:f.merchantId,paymentId:f.paymentId,refundId,providerTransactionId:`re_${randomUUID()}`,amount:1000,currency:f.currency});
      });
      void writing.catch(() => undefined);
      await barrier(writerReady.promise); await blocked(writerPid,capturePid);
      const [pending]=await database.sql`select captured_amount::text,refunded_amount::text from payments where id=${f.paymentId}`;
      expect(pending).toEqual({captured_amount:'10000',refunded_amount:'0'});
    } finally { release.resolve(); results=await Promise.allSettled([replaying,writing]); }
    expect(results.map((result) => result.status)).toEqual(['fulfilled','fulfilled']);
    expect(await state(f)).toMatchObject({status:'PARTIALLY_REFUNDED',captured_amount:'10000',platform_fee_amount:'300',journals:1,lots:1,audits:1});
    const [final]=await database.sql`select p.refunded_amount::text,r.status,r.platform_fee_amount::text,
      (select count(*)::integer from ledger_transactions where business_type='REFUND' and business_id=r.id and status='POSTED') as journals
      from payments p join refunds r on r.payment_id=p.id where r.id=${refundId}`;
    expect(final).toEqual({refunded_amount:'1000',status:'SUCCEEDED',platform_fee_amount:'30',journals:1});
    expect(await lot(f)).toEqual(original);
  },20000);
  it('processes concurrent distinct signed inbox deliveries of the same capture once', async () => {
    const f=await capture(); const secret='whsec_b21_local_fixture'; const stripe=new Stripe('sk_test_placeholder');
    const receiver=new WebhookReceiverService(new ConfigService({STRIPE_WEBHOOK_SECRET:secret}),database,stripe);
    const inboxIds: string[]=[];
    for (let i=0;i<2;i++) {
      const raw=JSON.stringify({id:`evt_${randomUUID()}`,object:'event',created:Math.floor(Date.now()/1000),type:'payment_intent.succeeded',
        data:{object:{id:f.providerId,object:'payment_intent',amount:f.amount,amount_received:f.amount,currency:'usd',status:'succeeded',livemode:false,
          metadata:{merchantId:f.merchantId,paymentId:f.paymentId,captureAttemptId:f.attemptId,captureAmount:String(f.amount)}}}});
      const signature=stripe.webhooks.generateTestHeaderString({payload:raw,secret});
      inboxIds.push((await receiver.receive(Buffer.from(raw),signature)).id);
    }
    await Promise.all([new WebhookProcessorService(database,business).drain(),new WebhookProcessorService(database,business).drain()]);
    const rows=await database.sql`select status from webhook_events where id in ${database.sql(inboxIds)}`;
    expect(rows).toHaveLength(2); expect(rows.every((row) => row.status==='PROCESSED')).toBe(true);
    expect(await state(f)).toMatchObject({journals:1,lots:1,audits:1,captured_amount:'10000'});
  });
  it('retains F02 sealing and original lot immutability after integrated capture', async () => {
    const f=await capture(); await apply(event(f)); const before=await lot(f);
    const [entry]=await database.sql<{id:string;transaction_id:string;account_id:string;currency:string}[]>`select * from ledger_entries where transaction_id=${before.capture_journal_id} limit 1`;
    await expect(database.sql`insert into ledger_entries (transaction_id,account_id,currency,debit,credit)
      values (${entry.transaction_id},${entry.account_id},${entry.currency},1,0)`).rejects.toThrow(/DRAFT|posted/i);
    await expect(database.sql`update ledger_entries set debit=debit+1 where id=${entry.id}`).rejects.toThrow(/immutable/i);
    await expect(database.sql`delete from ledger_entries where id=${entry.id}`).rejects.toThrow(/immutable/i);
    await expect(database.sql`update capture_accounting_lots set eligible_at=eligible_at+interval '1 day' where id=${before.id}`).rejects.toThrow(/immutable/i);
    expect(await lot(f)).toEqual(before);
  });
});
