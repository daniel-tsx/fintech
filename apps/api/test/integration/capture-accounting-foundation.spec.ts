import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DatabaseService, type DbTransaction } from '../../src/database/database.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { AuditService } from '../../src/audit/audit.service';
import { SettlementsService } from '../../src/settlements/settlements.service';
import { accountContributions, captureFixture } from '../support/accounting-fixtures';
import { captureRefundFeeDelta } from '../../src/ledger/capture-allocation';
import type { LedgerLine } from '../../src/ledger/ledger.types';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Capture = Awaited<ReturnType<typeof captureFixture>> & { lotId: string };
describeDatabase('B1 capture accounting foundation (no runtime activation)', () => {
  let database: DatabaseService; let ledger: LedgerService;
  beforeAll(() => {
    database = new DatabaseService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
    ledger = new LedgerService(database);
  });
  afterAll(async () => { await database.onApplicationShutdown(); });
  async function capture(gross = 10000, fee = 300, legacyEligibility = false, scope?: { merchantId: string; paymentId: string }): Promise<Capture> {
    const f = await captureFixture(database,gross,fee,scope);
    await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${f.merchantId},'USD') on conflict do nothing`;
    const [lot] = await database.sql<{ id: string }[]>`insert into capture_accounting_lots
      (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at,origin)
      select ${f.attemptId},${f.paymentId},${f.merchantId},'USD',id,${gross},${fee},${gross-fee},posted_at,case when ${legacyEligibility} then null else posted_at end,${legacyEligibility?'LEGACY_ORIGINAL_ONLY':'NEW_CAPTURE'} from ledger_transactions where id=${f.journalId} returning id`;
    return { ...f,lotId:lot.id };
  }
  async function refund(f: Capture, amount: number) {
    const [r] = await database.sql<{id:string}[]>`insert into refunds (merchant_id,payment_id,amount,currency) values (${f.merchantId},${f.paymentId},${amount},'USD') returning id`;
    return r.id;
  }
  async function reserve(tx: DbTransaction, f: Capture, refundId: string, amount: number) {
    const [r] = await tx<{id:string}[]>`insert into refund_capture_allocations (refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross)
      values (${refundId},${f.lotId},${f.paymentId},${f.merchantId},'USD',${amount}) returning id`;
    return r.id;
  }
  async function evidence(f: Capture, refundId: string, amount: number, type = 'refund.succeeded') {
    const payload = { type,data:{refundId,paymentId:f.paymentId,merchantId:f.merchantId,currency:'USD',amount} };
    // Fixture evidence is applied by explicit test SQL, never by inbox workers.
    const [event] = await database.sql<{id:string}[]>`insert into webhook_events (provider,provider_event_id,event_type,signature,payload,status)
      values ('STRIPE',${randomUUID()},${type},'local-fixture',${database.sql.json(payload)},'IGNORED') returning id`;
    return event.id;
  }
  async function confirm(f: Capture, refundId: string, amount: number, fee: number) {
    return confirmAllocations(f,refundId,amount,[{capture:f,gross:amount,fee}]);
  }
  async function confirmAllocations(f: Capture, refundId: string, amount: number, allocations: { capture: Capture; gross: number; fee: number }[]) {
    const eventId = await evidence(f,refundId,amount);
    return database.transaction(async (tx) => {
      const lines: LedgerLine[] = [];
      for (const a of allocations) {
        const [lot] = await tx`select settlement_state from capture_accounting_lots where id=${a.capture.lotId}`;
        const settled = lot.settlement_state==='FINALIZED';
        lines.push(
          ...(a.gross-a.fee ? [{accountCode:settled?'MERCHANT_AVAILABLE' as const:'MERCHANT_PENDING' as const,merchantId:f.merchantId,debit:a.gross-a.fee}] : []),
          ...(a.fee ? [{accountCode:'PLATFORM_FEE_REFUNDS' as const,merchantId:null,debit:a.fee}] : []),
          {accountCode:settled?'PLATFORM_CASH':'PSP_CLEARING',merchantId:null,credit:a.gross},
        );
      }
      const journal = await ledger.post(tx,{merchantId:f.merchantId,businessType:'REFUND',businessId:refundId,currency:'USD',description:'B1 confirmed fixture',lines});
      for (const a of allocations) await tx`update refund_capture_allocations set status='CONFIRMED',confirmed_gross=reserved_gross,confirmed_fee=${a.fee},journal_id=${journal},provider_event_id=${eventId} where refund_id=${refundId} and capture_lot_id=${a.capture.lotId}`;
      return journal;
    });
  }
  async function journalFingerprint(journalId: string) {
    const [row] = await database.sql`select to_jsonb(t) as header,
      (select jsonb_agg(to_jsonb(e) order by e.id) from ledger_entries e where e.transaction_id=t.id) as entries
      from ledger_transactions t where t.id=${journalId}`;
    return row;
  }
  async function finalizationState(f: Capture, c: Awaited<ReturnType<typeof candidate>>) {
    const [row] = await database.sql`select s.status,s.finalization_result as batch_result,i.finalization_result as item_result,
      l.settlement_state,l.finalized_settlement_item_id,
      (select count(*)::integer from ledger_transactions where business_type='SETTLEMENT' and business_id=s.id) as journals
      from settlements s join settlement_items i on i.settlement_id=s.id join capture_accounting_lots l on l.id=i.capture_lot_id
      where s.id=${c.batchId} and l.id=${f.lotId}`;
    return row;
  }
  async function dispute(f: Capture, gross: number, hold: number, status = 'PLANNED') {
    return database.transaction(async (tx) => {
      const [d] = await tx<{id:string}[]>`insert into disputes (merchant_id,payment_id,provider_dispute_id,status,amount,currency,opened_at)
        values (${f.merchantId},${f.paymentId},${randomUUID()},'OPEN',${gross},'USD',now()) returning id`;
      const journal = status==='OPEN' && hold>0 ? await ledger.post(tx,{merchantId:f.merchantId,businessType:'DISPUTE_OPEN',businessId:d.id,currency:'USD',description:'B1 open fixture',lines:[
        {accountCode:'MERCHANT_PENDING',merchantId:f.merchantId,debit:hold},{accountCode:'DISPUTE_CLEARING',merchantId:f.merchantId,credit:hold},
      ]}) : null;
      const [a] = await tx<{id:string}[]>`insert into dispute_capture_allocations (dispute_id,capture_lot_id,payment_id,merchant_id,currency,gross_principal,funded_hold,unfunded_exposure,status,open_journal_id)
        values (${d.id},${f.lotId},${f.paymentId},${f.merchantId},'USD',${gross},${hold},${gross-hold},${status},${journal}) returning id`;
      return { disputeId:d.id,allocationId:a.id };
    });
  }
  async function candidate(f: Capture) {
    return database.transaction(async (tx) => {
      const [s] = await tx<{id:string}[]>`insert into settlements (merchant_id,currency,gross_amount,fee_amount,net_amount,available_on,accounting_policy_version,estimated_asset_transfer,estimated_merchant_release)
        values (${f.merchantId},'USD',${f.gross},${f.fee},${f.gross-f.fee},now(),'CAPTURE_FIFO_V1',${f.gross},${f.gross-f.fee}) returning id`;
      const [item] = await tx<{id:string}[]>`insert into settlement_items (settlement_id,payment_id,capture_attempt_id,gross_amount,fee_amount,net_amount,currency,capture_lot_id,accounting_policy_version,estimated_asset_transfer,estimated_merchant_release,selected_revision)
        select ${s.id},${f.paymentId},${f.attemptId},${f.gross},${f.fee},${f.gross-f.fee},'USD',id,'CAPTURE_FIFO_V1',${f.gross},${f.gross-f.fee},allocation_revision from capture_accounting_lots where id=${f.lotId} returning id`;
      return {batchId:s.id,itemId:item.id};
    });
  }
  async function finalize(f: Capture, c: Awaited<ReturnType<typeof candidate>>, asset: number, release: number, hold = 0) {
    return database.transaction(async (tx) => {
      await tx`select id from settlements where id=${c.batchId} for update`;
      const [lot] = await tx<{allocation_revision:string}[]>`select allocation_revision::text from capture_accounting_lots where id=${f.lotId} for update`;
      const result = asset || release ? 'POSTED' : 'ZERO_EFFECT';
      const journal = result==='POSTED' ? await ledger.post(tx,{merchantId:f.merchantId,businessType:'SETTLEMENT',businessId:c.batchId,currency:'USD',description:'B1 final evidence fixture',lines:[
        ...(asset ? [{accountCode:'PLATFORM_CASH' as const,merchantId:null,debit:asset},{accountCode:'PSP_CLEARING' as const,merchantId:null,credit:asset}] : []),
        ...(release ? [{accountCode:'MERCHANT_PENDING' as const,merchantId:f.merchantId,debit:release},{accountCode:'MERCHANT_AVAILABLE' as const,merchantId:f.merchantId,credit:release}] : []),
      ]}) : null;
      await tx`update settlement_items set finalized_asset_transfer=${asset},finalized_merchant_release=${release},restricted_hold=${hold},applied_revision=${lot.allocation_revision},finalization_result=${result},accounting_journal_id=${journal},accounting_finalized_at=now() where id=${c.itemId}`;
      await tx`update capture_accounting_lots set settlement_state='FINALIZED',finalized_settlement_item_id=${c.itemId} where id=${f.lotId}`;
      await tx`update settlements set status='SUCCEEDED',finalized_asset_transfer=${asset},finalized_merchant_release=${release},finalization_result=${result},accounting_journal_id=${journal},accounting_finalized_at=now() where id=${c.batchId}`;
    });
  }
  it('validates original journal values, capture uniqueness and frozen eligibility', async () => {
    const f = await capture();
    await expect(database.sql`update capture_accounting_lots set original_fee=301,original_net=9699 where id=${f.lotId}`).rejects.toThrow(/immutable/i);
    await expect(database.sql`update capture_accounting_lots set eligible_at=eligible_at+interval '1 day' where id=${f.lotId}`).rejects.toThrow(/immutable/i);
    await expect(database.sql`insert into capture_accounting_lots select gen_random_uuid(),capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at,origin,policy_version,0,'UNSETTLED',null,now() from capture_accounting_lots where id=${f.lotId}`).rejects.toThrow(/unique/i);
    const other = await captureFixture(database);
    await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${other.merchantId},'USD')`;
    await expect(database.sql`insert into capture_accounting_lots (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at)
      select ${other.attemptId},${other.paymentId},${other.merchantId},'USD',id,10000,301,9699,posted_at,posted_at from ledger_transactions where id=${other.journalId}`).rejects.toThrow(/agree with one immutable POSTED CAPTURE/i);
  });
  it.each(['payment','merchant','currency'])('rejects cross-%s ownership', async (dimension) => {
    const f = await capture(); const other = await capture(); const r = await refund(f,100);
    await expect(database.transaction((tx) => tx`insert into refund_capture_allocations (refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross)
      values (${r},${f.lotId},${dimension==='payment'?other.paymentId:f.paymentId},${dimension==='merchant'?other.merchantId:f.merchantId},${dimension==='currency'?'EUR':'USD'},100)`)).rejects.toThrow(/foreign key/i);
  });
  it('requires positive whole-intent allocations, uniqueness and frozen identity', async () => {
    const f = await capture(); const r = await refund(f,100);
    await expect(database.transaction((tx) => reserve(tx,f,r,0))).rejects.toThrow(/check constraint/i);
    await expect(database.transaction((tx) => reserve(tx,f,r,50))).rejects.toThrow(/whole accepted/i);
    await database.transaction((tx) => reserve(tx,f,r,100));
    await expect(database.transaction((tx) => reserve(tx,f,r,100))).rejects.toThrow(/unique/i);
    await expect(database.sql`update refund_capture_allocations set reserved_gross=50 where refund_id=${r}`).rejects.toThrow(/immutable/i);
    await expect(database.sql`update refunds set amount=50 where id=${r}`).rejects.toThrow(/immutable/i);
  });
  it('bounds aggregate principal and rolls back allocation/revision on commit rejection', async () => {
    const f = await capture(); const a = await refund(f,7000); const b = await refund(f,4000);
    await database.transaction((tx) => reserve(tx,f,a,7000));
    await expect(database.transaction((tx) => reserve(tx,f,b,4000))).rejects.toThrow(/capacity/i);
    const [lot] = await database.sql`select allocation_revision::text as revision,(select count(*)::integer from refund_capture_allocations where capture_lot_id=${f.lotId}) as count from capture_accounting_lots where id=${f.lotId}`;
    expect(lot).toMatchObject({revision:'1',count:1});
  });
  it('releases only with final failed evidence; unknown outcomes remain reserved', async () => {
    const f = await capture(); const r = await refund(f,100); await database.transaction((tx) => reserve(tx,f,r,100));
    const unknown = await evidence(f,r,100,'refund.pending');
    await expect(database.sql`update refund_capture_allocations set status='RELEASED',provider_event_id=${unknown},release_reason='CONFIRMED_PROVIDER_FAILURE' where refund_id=${r}`).rejects.toThrow(/confirmed provider evidence/i);
    const failed = await evidence(f,r,100,'refund.failed');
    await database.sql`update refund_capture_allocations set status='RELEASED',provider_event_id=${failed},release_reason='CONFIRMED_PROVIDER_FAILURE' where refund_id=${r}`;
    await expect(database.sql`update refund_capture_allocations set status='RESERVED',provider_event_id=null,release_reason=null where refund_id=${r}`).rejects.toThrow(/immutable/i);
  });
  it('enforces cumulative fee rounding and atomic immutable confirmed effects', async () => {
    const f = await capture(1000,101);
    for (const [gross,fee] of [[333,33],[333,34],[334,34]]) {
      const r = await refund(f,gross); await database.transaction((tx) => reserve(tx,f,r,gross));
      if (gross===334) await expect(confirm(f,r,gross,33)).rejects.toThrow(/cumulatively/i);
      await confirm(f,r,gross,fee);
      await expect(database.sql`update refund_capture_allocations set confirmed_fee=confirmed_fee where refund_id=${r}`).rejects.toThrow(/immutable/i);
    }
    const [row] = await database.sql`select sum(confirmed_fee)::text as fee from refund_capture_allocations where capture_lot_id=${f.lotId}`;
    expect(row.fee).toBe('101');
    await expect(database.sql`update ledger_entries set debit=debit where transaction_id=${f.journalId}`).rejects.toThrow(/immutable/i);
  });
  it.each([
    {name:'review counterexample and bigint final remainder',gross:9223372036854775807n,fee:9223372036854775806n,refunds:[4611686018427387903n,4611686018427387903n,1n]},
    {name:'maximum fee equals maximum gross',gross:9223372036854775807n,fee:9223372036854775807n,refunds:[4611686018427387903n,4611686018427387904n]},
    {name:'above Number safe integer range',gross:9007199254740993n,fee:123456789012345n,refunds:[9007199254740992n,1n]},
    {name:'cumulative partial refund rounding',gross:1000n,fee:101n,refunds:[333n,333n,334n]},
    {name:'fixed capture fee and final remainder',gross:10000n,fee:100n,refunds:[3000n,6999n,1n]},
  ])('matches stored PostgreSQL fees to BigInt: $name', async ({gross,fee,refunds}) => {
    const merchantId = randomUUID(), paymentId = randomUUID(), attemptId = randomUUID();
    // Direct exact SQL fixtures exercise the new bigint correctness boundary;
    // they deliberately do not change the legacy Number-based LedgerService.
    async function exactJournal(tx: DbTransaction, businessType: string, businessId: string,
      lines: {code:string;type:string;owner:string|null;debit:bigint;credit:bigint}[]) {
      const [journal] = await tx<{id:string}[]>`insert into ledger_transactions (merchant_id,business_type,business_id,currency,description)
        values (${merchantId},${businessType},${businessId},'USD','Exact allocation regression fixture') returning id`;
      for (const line of lines.filter((l) => l.debit>0n || l.credit>0n)) {
        await tx`insert into ledger_accounts (merchant_id,code,account_type,currency,name) values (${line.owner},${line.code},${line.type},'USD','Exact fixture') on conflict do nothing`;
        const [account] = await tx<{id:string}[]>`select id from ledger_accounts where merchant_id is not distinct from ${line.owner}::uuid and code=${line.code} and currency='USD'`;
        await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) values (${journal.id},${account.id},'USD',${line.debit.toString()},${line.credit.toString()})`;
      }
      await tx`update ledger_transactions set status='POSTED',posted_at=now() where id=${journal.id}`;
      return journal.id;
    }
    const captureJournal = await database.transaction(async (tx) => {
      await tx`insert into merchants (id,name,settlement_delay_days) values (${merchantId},'Exact B1 fixture',0)`;
      await tx`insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,captured_amount,platform_fee_amount,payment_method_token)
        values (${paymentId},${merchantId},'CAPTURED','MANUAL','USD',${gross.toString()},${gross.toString()},${gross.toString()},${fee.toString()},'pm_test')`;
      await tx`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency) values (${attemptId},${merchantId},${paymentId},'CAPTURE','SUCCEEDED',${gross.toString()},'USD')`;
      return exactJournal(tx,'CAPTURE',attemptId,[
        {code:'PSP_CLEARING',type:'ASSET',owner:null,debit:gross,credit:0n},
        {code:'MERCHANT_PENDING',type:'LIABILITY',owner:merchantId,debit:0n,credit:gross-fee},
        {code:'PLATFORM_FEE_REVENUE',type:'REVENUE',owner:null,debit:0n,credit:fee},
      ]);
    });
    const original = await journalFingerprint(captureJournal);
    await database.sql`insert into capture_accounting_scopes (merchant_id,currency) values (${merchantId},'USD')`;
    const [lot] = await database.sql<{id:string}[]>`insert into capture_accounting_lots (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,original_gross,original_fee,original_net,financial_captured_at,eligible_at)
      select ${attemptId},${paymentId},${merchantId},'USD',id,${gross.toString()},${fee.toString()},${(gross-fee).toString()},posted_at,posted_at from ledger_transactions where id=${captureJournal} returning id`;
    let cumulativeGross = 0n, cumulativeFee = 0n;
    for (const amount of refunds) {
      const delta = captureRefundFeeDelta({originalGross:gross,originalFee:fee,previousConfirmedGross:cumulativeGross,cumulativeConfirmedGross:cumulativeGross+amount,previousConfirmedFee:cumulativeFee});
      const [r] = await database.sql<{id:string}[]>`insert into refunds (merchant_id,payment_id,amount,currency) values (${merchantId},${paymentId},${amount.toString()},'USD') returning id`;
      await database.sql`insert into refund_capture_allocations (refund_id,capture_lot_id,payment_id,merchant_id,currency,reserved_gross) values (${r.id},${lot.id},${paymentId},${merchantId},'USD',${amount.toString()})`;
      const payload = {type:'refund.succeeded',data:{refundId:r.id,paymentId,merchantId,currency:'USD',amount:amount.toString()}};
      const [event] = await database.sql<{id:string}[]>`insert into webhook_events (provider,provider_event_id,event_type,signature,payload,status)
        values ('STRIPE',${randomUUID()},'refund.succeeded','local-fixture',${database.sql.json(payload)},'IGNORED') returning id`;
      async function applyFee(value: bigint) {
        return database.transaction(async (tx) => {
          const journal = await exactJournal(tx,'REFUND',r.id,[
            {code:'MERCHANT_PENDING',type:'LIABILITY',owner:merchantId,debit:amount-value,credit:0n},
            {code:'PLATFORM_FEE_REFUNDS',type:'EXPENSE',owner:null,debit:value,credit:0n},
            {code:'PSP_CLEARING',type:'ASSET',owner:null,debit:0n,credit:amount},
          ]);
          await tx`update refund_capture_allocations set status='CONFIRMED',confirmed_gross=reserved_gross,confirmed_fee=${value.toString()},journal_id=${journal},provider_event_id=${event.id} where refund_id=${r.id}`;
          return journal;
        });
      }
      if (cumulativeGross===0n && delta<amount && delta<fee) {
        const [before] = await database.sql`select allocation_revision::text as revision from capture_accounting_lots where id=${lot.id}`;
        await expect(applyFee(delta+1n)).rejects.toThrow(/cumulatively/i);
        const [after] = await database.sql`select allocation_revision::text as revision,(select count(*)::integer from ledger_transactions where business_type='REFUND' and business_id=${r.id}) as journals from capture_accounting_lots where id=${lot.id}`;
        expect(after).toEqual({...before,journals:0});
      }
      const journal = await applyFee(delta); cumulativeGross+=amount; cumulativeFee+=delta;
      const [stored] = await database.sql`select a.status,a.confirmed_gross::text as gross,a.confirmed_fee::text as fee,a.journal_id,j.status as journal_status from refund_capture_allocations a join ledger_transactions j on j.id=a.journal_id where a.refund_id=${r.id}`;
      expect(stored).toMatchObject({status:'CONFIRMED',gross:amount.toString(),fee:delta.toString(),journal_id:journal,journal_status:'POSTED'});
      const [total] = await database.sql`select sum(confirmed_gross)::text as gross,sum(confirmed_fee)::text as fee from refund_capture_allocations where capture_lot_id=${lot.id}`;
      expect(total).toEqual({gross:cumulativeGross.toString(),fee:cumulativeFee.toString()});
      expect(cumulativeFee).toBeLessThanOrEqual(fee);
    }
    expect(cumulativeGross).toBe(gross); expect(cumulativeFee).toBe(fee);
    expect(await journalFingerprint(captureJournal)).toEqual(original);
    const balances = await database.transaction((tx) => accountContributions(tx,merchantId));
    expect(balances.PSP_CLEARING).toBe('0'); expect(balances.MERCHANT_PENDING ?? '0').toBe('0');
    expect(balances.PLATFORM_FEE_REFUNDS).toBe(fee.toString());
  });
  it('bounds funded holds separately from gross exposure and prevents principal overlap', async () => {
    const f = await capture();
    await expect(dispute(f,10000,10000)).rejects.toThrow(/surviving merchant entitlement/i);
    await dispute(f,10000,9700);
    const r = await refund(f,1); await expect(database.transaction((tx) => reserve(tx,f,r,1))).rejects.toThrow(/overlaps/i);
  });
  it('preserves append-only hold adjustment journals and final dispute outcomes', async () => {
    const f = await capture(); const d = await dispute(f,5000,5000,'OPEN'); const effectId = randomUUID();
    const eventId = await evidence(f,randomUUID(),5000,'dispute.closed');
    const journal = await database.transaction((tx) => ledger.post(tx,{merchantId:f.merchantId,businessType:'DISPUTE_HOLD_ADJUSTMENT',businessId:effectId,currency:'USD',description:'B1 hold adjustment fixture',lines:[
      {accountCode:'DISPUTE_CLEARING',merchantId:f.merchantId,debit:150},{accountCode:'MERCHANT_PENDING',merchantId:f.merchantId,credit:150},
    ]}));
    await database.sql`insert into dispute_hold_effects (id,allocation_id,capture_lot_id,payment_id,merchant_id,currency,effect_key,hold_delta,journal_id,provider_event_id,cause_dispute_id)
      values (${effectId},${d.allocationId},${f.lotId},${f.paymentId},${f.merchantId},'USD','adjust-1',-150,${journal},${eventId},${d.disputeId})`;
    await expect(database.sql`update dispute_hold_effects set hold_delta=-151 where id=${effectId}`).rejects.toThrow(/append-only/i);
    await database.transaction(async (tx) => {
      const close = await ledger.post(tx,{merchantId:f.merchantId,businessType:'DISPUTE_CLOSE',businessId:d.disputeId,currency:'USD',description:'B1 win fixture',lines:[
        {accountCode:'DISPUTE_CLEARING',merchantId:f.merchantId,debit:4850},{accountCode:'MERCHANT_PENDING',merchantId:f.merchantId,credit:4850},
      ]});
      await tx`update dispute_capture_allocations set status='CLOSED',outcome='MERCHANT_WON',close_journal_id=${close} where id=${d.allocationId}`;
    });
    await expect(database.sql`update dispute_capture_allocations set outcome='MERCHANT_LOST' where id=${d.allocationId}`).rejects.toThrow(/immutable/i);
  });
  it('stores idempotent exception evidence, scoped lot links and reviewed immutable resolution', async () => {
    const f = await capture(); const r = await refund(f,100); const eventId = await evidence(f,r,100);
    const insert = () => database.sql<{id:string}[]>`insert into accounting_exceptions (merchant_id,currency,payment_id,category,source_kind,evidence_key,provider_event_id,refund_id,observed_conflict)
      values (${f.merchantId},'USD',${f.paymentId},'REFUND_DISPUTE_PRINCIPAL_OVERLAP','WEBHOOK',${`webhook:${eventId}`},${eventId},${r},'{"principal":100}') on conflict (merchant_id,currency,category,evidence_key) do nothing returning id`;
    const [ex] = await insert(); expect(await insert()).toHaveLength(0);
    await database.sql`insert into accounting_exception_lots values (${ex.id},${f.lotId},${f.paymentId},${f.merchantId},'USD')`;
    await expect(database.sql`update accounting_exceptions set observed_conflict='{}' where id=${ex.id}`).rejects.toThrow(/immutable/i);
    const [user] = await database.sql<{id:string}[]>`insert into users (email,display_name,role) values (${`${randomUUID()}@example.test`},'B1 human fixture','PLATFORM_ADMIN') returning id`;
    await database.sql`update accounting_exceptions set status='RESOLVED',resolution_reference='review:B1-fixture',resolved_by=${user.id},resolved_at=now() where id=${ex.id}`;
    await expect(database.sql`update accounting_exceptions set resolution_reference='other' where id=${ex.id}`).rejects.toThrow(/immutable/i);
    const [scope] = await database.sql`select status from capture_accounting_scopes where merchant_id=${f.merchantId}`;
    expect(scope.status).toBe('REVIEW_REQUIRED'); // Resolution is not activation.
  });
  it('retains legacy settlement behavior with null foundation fields', async () => {
    const f = await capture(); const service = new SettlementsService(database,ledger,new AuditService());
    const [id] = await service.generate(f.merchantId); await database.transaction((tx) => service.complete(tx,id));
    const [s] = await database.sql`select status,accounting_policy_version from settlements where id=${id}`;
    expect(s).toMatchObject({status:'SUCCEEDED',accounting_policy_version:null});
    const [lot] = await database.sql`select settlement_state from capture_accounting_lots where id=${f.lotId}`;
    expect(lot.settlement_state).toBe('UNSETTLED'); // Foundation is deliberately nonauthoritative.
  });
  it('supports a real zero-effect candidate without a zero journal and freezes final evidence', async () => {
    const f = await capture(); const c = await candidate(f); const r = await refund(f,10000);
    await database.transaction((tx) => reserve(tx,f,r,10000)); await confirm(f,r,10000,300);
    await expect(finalize(f,c,10000,9700)).rejects.toThrow(/confirmed capture allocations/i);
    await finalize(f,c,0,0);
    const [row] = await database.sql`select finalization_result,accounting_journal_id from settlements where id=${c.batchId}`;
    expect(row).toMatchObject({finalization_result:'ZERO_EFFECT',accounting_journal_id:null});
    const [journals] = await database.sql`select count(*)::integer as count from ledger_transactions where business_type='SETTLEMENT' and business_id=${c.batchId}`;
    expect(journals.count).toBe(0);
    await expect(database.sql`update settlement_items set finalized_asset_transfer=1 where id=${c.itemId}`).rejects.toThrow(/immutable|Finalized batch/i);
  });
  it.each(['POSTED','ZERO_EFFECT'])('rejects %s item/lot finalization without a completed batch and rolls back', async (result) => {
    const f = await capture();
    if (result==='ZERO_EFFECT') {
      const r = await refund(f,10000); await database.transaction((tx) => reserve(tx,f,r,10000)); await confirm(f,r,10000,300);
    }
    const c = await candidate(f); const before = await finalizationState(f,c); const original = await journalFingerprint(f.journalId);
    await database.sql`insert into accounting_exceptions (merchant_id,currency,payment_id,category,source_kind,evidence_key,observed_conflict)
      values (${f.merchantId},'USD',${f.paymentId},'SETTLEMENT_ELIGIBILITY_CONFLICT','INTERNAL','partial-finalization','{}')`;
    await expect(database.transaction(async (tx) => {
      const [lot] = await tx<{allocation_revision:string}[]>`select allocation_revision from capture_accounting_lots where id=${f.lotId}`;
      const [draft] = result==='POSTED' ? await tx<{id:string}[]>`insert into ledger_transactions (merchant_id,business_type,business_id,currency,description)
        values (${f.merchantId},'SETTLEMENT',${c.batchId},'USD','Intentionally incomplete local fixture') returning id` : [];
      await tx`update settlement_items set finalized_asset_transfer=${result==='POSTED'?10000:0},finalized_merchant_release=${result==='POSTED'?9700:0},restricted_hold=0,
        applied_revision=${lot.allocation_revision},finalization_result=${result},accounting_journal_id=${draft?.id ?? null},accounting_finalized_at=now() where id=${c.itemId}`;
      await tx`update capture_accounting_lots set settlement_state='FINALIZED',finalized_settlement_item_id=${c.itemId} where id=${f.lotId}`;
      // The batch deliberately remains PENDING; rejection must happen at commit.
    })).rejects.toThrow(/finalized capture allocations require a completed foundation batch/i);
    expect(await finalizationState(f,c)).toEqual(before);
    expect(await journalFingerprint(f.journalId)).toEqual(original);
    const [exception] = await database.sql`select status from accounting_exceptions where merchant_id=${f.merchantId}`;
    expect(exception.status).toBe('OPEN');
  });
  it('rejects a completed positive batch referencing a DRAFT journal and rolls back', async () => {
    const f = await capture(); const c = await candidate(f); const before = await finalizationState(f,c);
    await expect(database.transaction(async (tx) => {
      const [draft] = await tx<{id:string}[]>`insert into ledger_transactions (merchant_id,business_type,business_id,currency,description)
        values (${f.merchantId},'SETTLEMENT',${c.batchId},'USD','Intentionally unposted local fixture') returning id`;
      await tx`update settlement_items set finalized_asset_transfer=10000,finalized_merchant_release=9700,restricted_hold=0,applied_revision=0,
        finalization_result='POSTED',accounting_journal_id=${draft.id},accounting_finalized_at=now() where id=${c.itemId}`;
      await tx`update capture_accounting_lots set settlement_state='FINALIZED',finalized_settlement_item_id=${c.itemId} where id=${f.lotId}`;
      await tx`update settlements set status='SUCCEEDED',finalized_asset_transfer=10000,finalized_merchant_release=9700,
        finalization_result='POSTED',accounting_journal_id=${draft.id},accounting_finalized_at=now() where id=${c.batchId}`;
    })).rejects.toThrow(/matching immutable POSTED business journal/i);
    expect(await finalizationState(f,c)).toEqual(before);
  });
  it('rejects ZERO_EFFECT when positive capture obligations remain', async () => {
    const f = await capture(); const c = await candidate(f); const before = await finalizationState(f,c);
    await expect(finalize(f,c,0,0)).rejects.toThrow(/confirmed capture allocations/i);
    expect(await finalizationState(f,c)).toEqual(before);
  });
  it('validates the completed transaction when batch and lot precede final item and journal posting', async () => {
    const f = await capture(); const c = await candidate(f);
    await database.transaction(async (tx) => {
      const [draft] = await tx<{id:string}[]>`insert into ledger_transactions (merchant_id,business_type,business_id,currency,description)
        values (${f.merchantId},'SETTLEMENT',${c.batchId},'USD','Deferred construction fixture') returning id`;
      await tx`update settlements set status='SUCCEEDED',finalized_asset_transfer=10000,finalized_merchant_release=9700,
        finalization_result='POSTED',accounting_journal_id=${draft.id},accounting_finalized_at=now() where id=${c.batchId}`;
      await tx`update capture_accounting_lots set settlement_state='FINALIZED',finalized_settlement_item_id=${c.itemId} where id=${f.lotId}`;
      await tx`update settlement_items set finalized_asset_transfer=10000,finalized_merchant_release=9700,restricted_hold=0,applied_revision=0,
        finalization_result='POSTED',accounting_journal_id=${draft.id},accounting_finalized_at=now() where id=${c.itemId}`;
      await tx`insert into ledger_accounts (merchant_id,code,account_type,currency,name) values
        (null,'PLATFORM_CASH','ASSET','USD','Fixture cash'),(${f.merchantId},'MERCHANT_AVAILABLE','LIABILITY','USD','Fixture available') on conflict do nothing`;
      await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit)
        select ${draft.id},id,'USD',case code when 'PLATFORM_CASH' then 10000 when 'MERCHANT_PENDING' then 9700 else 0 end,
          case code when 'PSP_CLEARING' then 10000 when 'MERCHANT_AVAILABLE' then 9700 else 0 end
        from ledger_accounts where currency='USD' and ((merchant_id is null and code in ('PLATFORM_CASH','PSP_CLEARING')) or (merchant_id=${f.merchantId} and code in ('MERCHANT_PENDING','MERCHANT_AVAILABLE')))`;
      await tx`update ledger_transactions set status='POSTED',posted_at=now() where id=${draft.id}`;
      await tx`set constraints all immediate`;
    });
    expect(await finalizationState(f,c)).toMatchObject({status:'SUCCEEDED',batch_result:'POSTED',item_result:'POSTED',settlement_state:'FINALIZED',journals:1});
    expect(await database.transaction((tx) => accountContributions(tx,f.merchantId))).toMatchObject({PSP_CLEARING:'0',PLATFORM_CASH:'10000',MERCHANT_PENDING:'0',MERCHANT_AVAILABLE:'9700'});
  });
  it('keeps ordinary pending refunds outside financial entitlement while confirmed holds stay restricted', async () => {
    const f = await capture(); const r = await refund(f,5000); await database.transaction((tx) => reserve(tx,f,r,5000));
    await dispute(f,5000,5000,'OPEN'); const c = await candidate(f); await finalize(f,c,10000,4700,5000);
    // A later refund changes the revision without rewriting prior settlement evidence.
    await expect(confirm(f,r,5000,150)).rejects.toThrow(/surviving merchant entitlement/i); // B2 must reduce the other hold atomically.
    const [row] = await database.sql`select finalized_merchant_release::text as released from settlements where id=${c.batchId}`;
    expect(row.released).toBe('4700');
  });
  it('blocks foundation finalization for unresolved scope evidence and unknown eligibility', async () => {
    const f = await capture(); const c = await candidate(f);
    await database.sql`insert into accounting_exceptions (merchant_id,currency,payment_id,category,source_kind,evidence_key,observed_conflict)
      values (${f.merchantId},'USD',${f.paymentId},'SETTLEMENT_ELIGIBILITY_CONFLICT','INTERNAL','eligibility','{}')`;
    await expect(finalize(f,c,10000,9700)).rejects.toThrow(/Unresolved accounting exceptions/i);
    const [row] = await database.sql`select settlement_state from capture_accounting_lots where id=${f.lotId}`;
    expect(row.settlement_state).toBe('UNSETTLED');
    const legacy = await capture(10000,300,true); const legacyCandidate = await candidate(legacy);
    await expect(finalize(legacy,legacyCandidate,10000,9700)).rejects.toThrow(/confirmed mature eligibility/i);
  });
  it('permits settlement with an ordinary reservation and a later confirmed refund without rewriting settlement', async () => {
    const f = await capture(); const r = await refund(f,5000); await database.transaction((tx) => reserve(tx,f,r,5000));
    const original = await journalFingerprint(f.journalId);
    const c = await candidate(f); await finalize(f,c,10000,9700);
    const [batchBefore] = await database.sql<{accounting_journal_id:string}[]>`select * from settlements where id=${c.batchId}`;
    const [itemBefore] = await database.sql`select * from settlement_items where id=${c.itemId}`;
    const settlementJournal = await journalFingerprint(batchBefore.accounting_journal_id);
    const refundJournal = await confirm(f,r,5000,150);
    const [row] = await database.sql`select finalized_asset_transfer::text as asset,finalized_merchant_release::text as released from settlements where id=${c.batchId}`;
    expect(row).toMatchObject({asset:'10000',released:'9700'});
    expect(await database.transaction((tx) => accountContributions(tx,f.merchantId))).toMatchObject({
      PSP_CLEARING:'0',PLATFORM_CASH:'5000',MERCHANT_PENDING:'0',MERCHANT_AVAILABLE:'4850',PLATFORM_FEE_REVENUE:'300',PLATFORM_FEE_REFUNDS:'150',
    });
    const [allocation] = await database.sql`select status,confirmed_gross::text as gross,confirmed_fee::text as fee,journal_id from refund_capture_allocations where refund_id=${r}`;
    expect(allocation).toMatchObject({status:'CONFIRMED',gross:'5000',fee:'150',journal_id:refundJournal});
    expect((await database.sql`select * from settlements where id=${c.batchId}`)[0]).toEqual(batchBefore);
    expect((await database.sql`select * from settlement_items where id=${c.itemId}`)[0]).toEqual(itemBefore);
    expect(await journalFingerprint(f.journalId)).toEqual(original);
    expect(await journalFingerprint(batchBefore.accounting_journal_id)).toEqual(settlementJournal);
  });
  it('splits a mixed settled/unsettled refund between cash/PSP and available/pending', async () => {
    const a = await capture(4000,120); const b = await capture(6000,180,false,a);
    const originals = await Promise.all([journalFingerprint(a.journalId),journalFingerprint(b.journalId)]);
    const c = await candidate(a); await finalize(a,c,4000,3880);
    const [batchBefore] = await database.sql<{accounting_journal_id:string}[]>`select * from settlements where id=${c.batchId}`;
    const [itemBefore] = await database.sql`select * from settlement_items where id=${c.itemId}`;
    const settlementJournal = await journalFingerprint(batchBefore.accounting_journal_id);
    const r = await refund(a,5000);
    await database.transaction(async (tx) => { await reserve(tx,a,r,4000); await reserve(tx,b,r,1000); });
    const journal = await confirmAllocations(a,r,5000,[{capture:a,gross:4000,fee:120},{capture:b,gross:1000,fee:30}]);
    expect(await database.transaction((tx) => accountContributions(tx,a.merchantId))).toMatchObject({
      PSP_CLEARING:'5000',PLATFORM_CASH:'0',MERCHANT_PENDING:'4850',MERCHANT_AVAILABLE:'0',PLATFORM_FEE_REVENUE:'300',PLATFORM_FEE_REFUNDS:'150',
    });
    const allocations = await database.sql`select capture_lot_id,status,confirmed_gross::text as gross,confirmed_fee::text as fee,journal_id from refund_capture_allocations where refund_id=${r}`;
    expect(allocations).toHaveLength(2);
    expect(allocations).toEqual(expect.arrayContaining([
      expect.objectContaining({capture_lot_id:a.lotId,status:'CONFIRMED',gross:'4000',fee:'120',journal_id:journal}),
      expect.objectContaining({capture_lot_id:b.lotId,status:'CONFIRMED',gross:'1000',fee:'30',journal_id:journal}),
    ]));
    const credits = await database.sql`select a.code,sum(e.credit)::text as credit from ledger_entries e join ledger_accounts a on a.id=e.account_id where e.transaction_id=${journal} and a.account_type='ASSET' group by a.code`;
    expect(credits).toEqual(expect.arrayContaining([{code:'PLATFORM_CASH',credit:'4000'},{code:'PSP_CLEARING',credit:'1000'}]));
    expect((await database.sql`select * from settlements where id=${c.batchId}`)[0]).toEqual(batchBefore);
    expect((await database.sql`select * from settlement_items where id=${c.itemId}`)[0]).toEqual(itemBefore);
    expect(await Promise.all([journalFingerprint(a.journalId),journalFingerprint(b.journalId)])).toEqual(originals);
    expect(await journalFingerprint(batchBefore.accounting_journal_id)).toEqual(settlementJournal);
  });
  it.each(['read committed','repeatable read'])('serializes competing capacity allocations at %s', async (isolation) => {
    const f = await capture(); const a = await refund(f,7000); const b = await refund(f,7000);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release=resolve; });
    let inserted!: () => void; const ready = new Promise<void>((resolve) => { inserted=resolve; });
    const first = database.transaction(async (tx) => { await reserve(tx,f,a,7000); inserted(); await gate; });
    await ready;
    let pid!: number; let began!: () => void; const beganGate = new Promise<void>((resolve) => { began=resolve; });
    const second = database.transaction(async (tx) => {
      await tx.unsafe(`set transaction isolation level ${isolation}`);
      const [row] = await tx<{pid:number}[]>`select pg_backend_pid() as pid`; pid=row.pid;
      await tx`select allocation_revision from capture_accounting_lots where id=${f.lotId}`; began();
      await reserve(tx,f,b,7000);
    }).then(() => null,(error: Error) => error);
    try {
      await beganGate; let blocked = false;
      for (let n=0;n<150;n++) {
        const [row] = await database.sql`select cardinality(pg_blocking_pids(${pid}))>0 as blocked`;
        if (row.blocked) { blocked=true; break; }
        await new Promise((resolve) => setTimeout(resolve,20));
      }
      expect(blocked).toBe(true);
    } finally { release(); }
    await first; expect((await second)?.message).toMatch(/capacity|serialize/i);
  },15000);
  it('serializes foundation finalization with an earlier uncommitted exception', async () => {
    const f = await capture(); const c = await candidate(f);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release=resolve; });
    let ready!: () => void; const readyGate = new Promise<void>((resolve) => { ready=resolve; }); let pid!: number;
    const first = database.transaction(async (tx) => {
      const [backend] = await tx<{pid:number}[]>`select pg_backend_pid() as pid`; pid=backend.pid;
      await tx`insert into accounting_exceptions (merchant_id,currency,payment_id,category,source_kind,evidence_key,observed_conflict)
        values (${f.merchantId},'USD',${f.paymentId},'SETTLEMENT_ELIGIBILITY_CONFLICT','INTERNAL','concurrent-evidence','{}')`;
      ready(); await gate;
    });
    await readyGate;
    const second = finalize(f,c,10000,9700).then(() => null,(error:Error) => error);
    try {
      let blocked = false;
      for (let n=0;n<150;n++) {
        const [row] = await database.sql`select exists (select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as blocked`;
        if (row.blocked) { blocked=true; break; }
        await new Promise((resolve) => setTimeout(resolve,20));
      }
      expect(blocked).toBe(true);
    } finally { release(); }
    await first; expect((await second)?.message).toMatch(/Unresolved accounting exceptions/i);
  },15000);
});
