import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/domain-error';
import { DatabaseService, type DbTransaction } from '../database/database.service';
import { CAPTURE_ACCOUNTING_POLICY } from '../ledger/capture-allocation';
import { exactLedgerAmount } from '../ledger/dispute-hold-adjustment';
import { LedgerService } from '../ledger/ledger.service';
import type { LedgerLine } from '../ledger/ledger.types';

interface Scope { merchant_id:string; currency:string }
interface Payment { id:string; captured_amount:string; refunded_amount:string }
interface Lot extends Scope {
  id:string; payment_id:string; capture_attempt_id:string; capture_journal_id:string; original_gross:string; original_fee:string; original_net:string;
  origin:string; mature:boolean; verified:boolean; allocation_revision:string; settlement_state:string; finalized_settlement_item_id:string|null;
  refunded:string; returned_fee:string; lost:string; held:string;
}
interface Batch extends Scope {
  id:string; status:string; accounting_policy_version:string|null; gross_amount:string; fee_amount:string; net_amount:string;
  estimated_asset_transfer:string; estimated_merchant_release:string; finalized_asset_transfer:string|null; finalized_merchant_release:string|null;
  finalization_result:string|null; accounting_journal_id:string|null; accounting_finalized_at:Date|null;
}
interface Item {
  id:string; settlement_id:string; capture_lot_id:string|null; capture_attempt_id:string; payment_id:string; currency:string;
  gross_amount:string; fee_amount:string; net_amount:string; accounting_policy_version:string|null;
  estimated_asset_transfer:string; estimated_merchant_release:string; selected_revision:string; applied_revision:string|null;
  finalized_asset_transfer:string|null; finalized_merchant_release:string|null; restricted_hold:string|null;
  finalization_result:string|null; accounting_journal_id:string|null; accounting_finalized_at:Date|null;
}
type Disposition='PROCESSED'|'ACCOUNTING_EXCEPTION';

// Deliberately absent from modules, routes, jobs and live financial dispatch.
export class CaptureSettlementAccountingService {
  constructor(private readonly database:DatabaseService,private readonly ledger:LedgerService,private readonly audit:AuditService) {}
  protected assertActiveScope(status:string):void {
    if(status!=='ACTIVE') throw new DomainError('ACCOUNTING_SCOPE_INACTIVE','Capture-level settlement accounting is not activated',409);
  }

  async generate(merchantId?:string,currency?:string):Promise<string[]> {
    // Discovery owns no financial locks. Each scope gets an independent transaction.
    const scopes=await this.database.sql<Scope[]>`select distinct merchant_id,currency from public.capture_accounting_lots
      where settlement_state='UNSETTLED' and eligible_at<=now()
        and (${merchantId??null}::uuid is null or merchant_id=${merchantId??null})
        and (${currency??null}::text is null or currency=${currency??null}) order by merchant_id,currency`;
    const ids:string[]=[];
    for(const scope of scopes) {
      const id=await this.database.transaction(async tx=>{
        await this.lockScope(tx,scope);
        if(await this.blocked(tx,scope)) return null;
        const rows=await tx<{payment_id:string}[]>`select distinct payment_id from public.capture_accounting_lots
          where merchant_id=${scope.merchant_id} and currency=${scope.currency} and settlement_state='UNSETTLED' and eligible_at<=now() order by payment_id`;
        if(!rows.length) return null;
        const payments=await this.lockMembers(tx,scope,rows.map(r=>r.payment_id));
        const lots=await this.readLots(tx,payments.map(p=>p.id));
        await this.checkInboxPrerequisites(tx,payments.map(p=>p.id));
        const conflict=await this.historyConflict(tx,payments,lots);
        if(conflict) {await this.review(tx,scope,lots,`generation:${payments.map(p=>p.id).join(':')}`,conflict); return null;}
        const owners=await tx<Item[]>`select * from public.settlement_items where payment_id in ${tx(payments.map(p=>p.id))}`;
        const candidates:Lot[]=[];
        for(const lot of lots.filter(l=>l.settlement_state==='UNSETTLED' && l.mature)) {
          const owner=owners.find(i=>i.capture_attempt_id===lot.capture_attempt_id);
          if(owner) {
            const batch=await this.batch(tx,owner.settlement_id);
            if(!batch || !this.candidateMatches(owner,lot,batch) || batch.status!=='PENDING' || batch.finalization_result!==null) {
              await this.review(tx,scope,lots,`generation:${lot.id}`,'Capture already has incompatible settlement ownership'); return null;
            }
          } else candidates.push(lot);
        }
        if(!candidates.length) return null;
        // New header is private/uncommitted; no shared header is locked after lots.
        const batchId=randomUUID();
        await tx`insert into public.settlements (id,merchant_id,currency,available_on,accounting_policy_version,estimated_asset_transfer,estimated_merchant_release)
          values (${batchId},${scope.merchant_id},${scope.currency},now(),${CAPTURE_ACCOUNTING_POLICY},0,0)`;
        const inserted:Item[]=[];
        for(const lot of candidates) {
          const amount=this.amounts(lot);
          const result=await tx<Item[]>`insert into public.settlement_items
            (settlement_id,payment_id,capture_attempt_id,gross_amount,fee_amount,net_amount,currency,capture_lot_id,accounting_policy_version,
              estimated_asset_transfer,estimated_merchant_release,selected_revision)
            values (${batchId},${lot.payment_id},${lot.capture_attempt_id},${lot.original_gross},${lot.original_fee},${lot.original_net},${scope.currency},${lot.id},
              ${CAPTURE_ACCOUNTING_POLICY},${amount.asset.toString()},${amount.release.toString()},${lot.allocation_revision})
            on conflict (capture_attempt_id) do nothing returning *`;
          if(result.length) inserted.push(result[0]);
          else {
            const [owner]=await tx<Item[]>`select * from public.settlement_items where capture_attempt_id=${lot.capture_attempt_id}`;
            const batch=owner?await this.batch(tx,owner.settlement_id):undefined;
            if(!owner || !batch || !this.candidateMatches(owner,lot,batch) || batch.status!=='PENDING' || batch.finalization_result!==null)
              throw new DomainError('SETTLEMENT_CANDIDATE_CONFLICT','Conflicting capture ownership requires whole-transaction retry/review',409);
          }
        }
        if(!inserted.length) throw new DomainError('SETTLEMENT_CANDIDATE_CONFLICT','No capture was inserted; roll back the private empty batch',409);
        const total=(field:'gross_amount'|'fee_amount'|'net_amount'|'estimated_asset_transfer'|'estimated_merchant_release')=>inserted.reduce((sum,i)=>sum+BigInt(i[field]),0n).toString();
        await tx`update public.settlements set gross_amount=${total('gross_amount')},fee_amount=${total('fee_amount')},net_amount=${total('net_amount')},
          estimated_asset_transfer=${total('estimated_asset_transfer')},estimated_merchant_release=${total('estimated_merchant_release')},updated_at=now() where id=${batchId}`;
        await this.audit.append(tx,{merchantId:scope.merchant_id,actor:{type:'SYSTEM'},action:'settlement.generated',targetType:'settlement',targetId:batchId,
          metadata:{accountingPolicy:CAPTURE_ACCOUNTING_POLICY,captureLots:inserted.map(i=>i.capture_lot_id),estimatedAssetTransfer:total('estimated_asset_transfer'),estimatedMerchantRelease:total('estimated_merchant_release')}});
        return batchId;
      });
      if(id) ids.push(id);
    }
    return ids;
  }

  async complete(tx:DbTransaction,settlementId:string):Promise<Disposition> {
    const identity=await this.batch(tx,settlementId);
    if(!identity) throw new DomainError('SETTLEMENT_NOT_FOUND','Settlement was not found',404);
    await this.lockScope(tx,identity);
    const [batch]=await tx<Batch[]>`select * from public.settlements where id=${settlementId} for update`;
    if(batch.merchant_id!==identity.merchant_id || batch.currency!==identity.currency) throw new DomainError('SETTLEMENT_SCOPE_CHANGED','Settlement identity changed',409);
    if(batch.accounting_policy_version!==CAPTURE_ACCOUNTING_POLICY) throw new DomainError('LEGACY_SETTLEMENT_REVIEW_REQUIRED','Legacy batches cannot be rebuilt under capture accounting',409);
    const selected=await tx<Item[]>`select * from public.settlement_items where settlement_id=${settlementId} order by payment_id,capture_attempt_id`;
    if(!selected.length) throw new DomainError('ACCOUNTING_INTEGRITY_CONFLICT','Settlement has no candidate items',409);
    const payments=await this.lockMembers(tx,batch,[...new Set(selected.map(i=>i.payment_id))]);
    const lots=await this.readLots(tx,payments.map(p=>p.id));
    const items=await tx<Item[]>`select * from public.settlement_items where settlement_id=${settlementId} order by capture_lot_id,id for update`;
    if(batch.status==='SUCCEEDED') {await this.validateReplay(tx,batch,items,lots); return 'PROCESSED';}
    if(batch.status!=='PENDING' || batch.finalization_result!==null) throw new DomainError('ACCOUNTING_INTEGRITY_CONFLICT','Settlement lifecycle is inconsistent',409);
    if(await this.blocked(tx,batch)) return 'ACCOUNTING_EXCEPTION';
    await this.checkInboxPrerequisites(tx,payments.map(p=>p.id));
    const conflict=await this.historyConflict(tx,payments,lots);
    if(conflict) return this.review(tx,batch,lots,`batch:${batch.id}`,conflict);
    const [existing]=await tx`select id from public.ledger_transactions where business_type='SETTLEMENT' and business_id=${batch.id}`;
    if(existing) return this.review(tx,batch,lots,`batch:${batch.id}`,'Pending batch already has unapplied financial journal evidence');
    const values=[] as Array<{item:Item;lot:Lot;asset:bigint;release:bigint;held:bigint}>;
    for(const item of items) {
      const lot=lots.find(l=>l.id===item.capture_lot_id);
      if(!lot || !this.candidateMatches(item,lot,batch) || item.finalization_result!==null || lot.settlement_state!=='UNSETTLED' || !lot.mature)
        return this.review(tx,batch,lots,`batch:${batch.id}`,'Candidate capture ownership, maturity or finalization is inconsistent');
      values.push({item,lot,...this.amounts(lot)});
    }
    for(const field of ['gross_amount','fee_amount','net_amount','estimated_asset_transfer','estimated_merchant_release'] as const) {
      if(items.reduce((sum,i)=>sum+BigInt(i[field]),0n)!==BigInt(batch[field]))
        return this.review(tx,batch,lots,`batch:${batch.id}`,'Batch original amounts or estimates disagree with immutable candidate items');
    }
    const asset=values.reduce((sum,v)=>sum+v.asset,0n),release=values.reduce((sum,v)=>sum+v.release,0n);
    const result=asset || release?'POSTED':'ZERO_EFFECT';
    // LedgerService sums Number sides; also validate the combined debit boundary.
    exactLedgerAmount(asset+release);
    const journal=result==='POSTED'?await this.ledger.post(tx,{merchantId:batch.merchant_id,businessType:'SETTLEMENT',businessId:batch.id,currency:batch.currency,
      description:`Capture-owned internal settlement ${batch.id}`,lines:this.lines(batch,asset,release)}):null;
    for(const v of values) {
      const itemResult=v.asset || v.release?'POSTED':'ZERO_EFFECT';
      await tx`update public.settlement_items set finalized_asset_transfer=${v.asset.toString()},finalized_merchant_release=${v.release.toString()},
        restricted_hold=${v.held.toString()},applied_revision=${v.lot.allocation_revision},finalization_result=${itemResult},
        accounting_journal_id=${itemResult==='POSTED'?journal:null},accounting_finalized_at=now() where id=${v.item.id}`;
      await tx`update public.capture_accounting_lots set settlement_state='FINALIZED',finalized_settlement_item_id=${v.item.id} where id=${v.lot.id}`;
    }
    await tx`update public.settlements set status='SUCCEEDED',finalized_asset_transfer=${asset.toString()},finalized_merchant_release=${release.toString()},
      finalization_result=${result},accounting_journal_id=${journal},accounting_finalized_at=now(),completed_at=now(),updated_at=now() where id=${batch.id}`;
    await this.audit.append(tx,{merchantId:batch.merchant_id,actor:{type:'SYSTEM'},action:'settlement.completed',targetType:'settlement',targetId:batch.id,
      metadata:{accountingPolicy:CAPTURE_ACCOUNTING_POLICY,result,assetTransfer:asset.toString(),merchantRelease:release.toString(),journalId:journal}});
    return 'PROCESSED';
  }

  private batch(tx:DbTransaction,id:string):Promise<Batch|undefined> {return tx<Batch[]>`select * from public.settlements where id=${id}`.then(rows=>rows[0]);}
  private async lockScope(tx:DbTransaction,scope:Scope):Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${scope.merchant_id}:${scope.currency}`},0))`;
    const [row]=await tx<{status:string}[]>`select status from public.capture_accounting_scopes where merchant_id=${scope.merchant_id} and currency=${scope.currency} for update`;
    this.assertActiveScope(row?.status??'MISSING');
  }
  private async blocked(tx:DbTransaction,scope:Scope):Promise<boolean> {
    const [row]=await tx<{blocked:boolean}[]>`select exists(select 1 from public.accounting_exceptions where merchant_id=${scope.merchant_id} and currency=${scope.currency} and status='OPEN') as blocked`;
    return row.blocked;
  }
  private async lockMembers(tx:DbTransaction,scope:Scope,ids:string[]):Promise<Payment[]> {
    const payments=await tx<Payment[]>`select id,captured_amount::text,refunded_amount::text from public.payments
      where id in ${tx(ids)} and merchant_id=${scope.merchant_id} and currency=${scope.currency} order by id for no key update`;
    if(payments.length!==ids.length) throw new DomainError('ACCOUNTING_INTEGRITY_CONFLICT','Settlement payment ownership is inconsistent',409);
    await tx`select id from public.payment_attempts where payment_id in ${tx(ids)} and kind='CAPTURE' order by id for update`;
    await tx`select id from public.refunds where payment_id in ${tx(ids)} order by id for update`;
    await tx`select id from public.disputes where payment_id in ${tx(ids)} order by id for update`;
    await tx`select id from public.capture_accounting_lots where payment_id in ${tx(ids)} order by capture_attempt_id for update`;
    await tx`select id from public.dispute_capture_allocations where payment_id in ${tx(ids)} order by capture_lot_id,id for update`;
    await tx`select id from public.refund_capture_allocations where payment_id in ${tx(ids)} order by capture_lot_id,id for update`;
    return payments;
  }
  private readLots(tx:DbTransaction,ids:string[]):Promise<Lot[]> {
    return tx<Lot[]>`select l.*,l.eligible_at<=now() as mature,
      (l.origin='NEW_CAPTURE' and l.eligible_at is not null and v.original_valid and
        (v.journal_id,v.gross,v.fee,v.net,v.financial_captured_at)=(l.capture_journal_id,l.original_gross,l.original_fee,l.original_net,l.financial_captured_at)) as verified,
      coalesce(r.gross,0)::text as refunded,coalesce(r.fee,0)::text as returned_fee,coalesce(d.lost,0)::text as lost,coalesce(d.held,0)::text as held
      from public.capture_accounting_lots l left join public.capture_accounting_legacy_inventory v on v.capture_attempt_id=l.capture_attempt_id
      left join lateral (select sum(confirmed_gross) as gross,sum(confirmed_fee) as fee from public.refund_capture_allocations where capture_lot_id=l.id and status='CONFIRMED') r on true
      left join lateral (select sum(gross_principal) filter(where status='CLOSED' and outcome='MERCHANT_LOST') as lost,
        sum(funded_hold+coalesce(e.delta,0)) filter(where status='OPEN') as held from public.dispute_capture_allocations a
        left join lateral (select sum(hold_delta) as delta from public.dispute_hold_effects where allocation_id=a.id) e on true where capture_lot_id=l.id) d on true
      where l.payment_id in ${tx(ids)} order by l.financial_captured_at,l.capture_attempt_id`;
  }
  private amounts(lot:Lot):{asset:bigint;release:bigint;held:bigint} {
    const asset=BigInt(lot.original_gross)-BigInt(lot.refunded)-BigInt(lot.lost);
    const entitlement=BigInt(lot.original_net)-(BigInt(lot.refunded)-BigInt(lot.returned_fee))-BigInt(lot.lost),held=BigInt(lot.held);
    if(asset<0n || held<0n || held>(entitlement>0n?entitlement:0n)) throw new DomainError('ACCOUNTING_INTEGRITY_CONFLICT','Capture contribution exceeds recognized asset or entitlement',409);
    return {asset,release:entitlement>held?entitlement-held:0n,held};
  }
  private candidateMatches(item:Item,lot:Lot,batch:Batch):boolean {
    return batch.accounting_policy_version===CAPTURE_ACCOUNTING_POLICY && item.accounting_policy_version===CAPTURE_ACCOUNTING_POLICY
      && batch.merchant_id===lot.merchant_id && batch.currency===lot.currency && item.currency===lot.currency && item.payment_id===lot.payment_id
      && item.capture_lot_id===lot.id && item.capture_attempt_id===lot.capture_attempt_id && item.gross_amount===lot.original_gross
      && item.fee_amount===lot.original_fee && item.net_amount===lot.original_net && BigInt(item.selected_revision)<=BigInt(lot.allocation_revision);
  }
  private async historyConflict(tx:DbTransaction,payments:Payment[],lots:Lot[]):Promise<string|null> {
    for(const p of payments) {
      const owned=lots.filter(l=>l.payment_id===p.id);
      if(!owned.length || owned.some(l=>!l.verified) || owned.reduce((sum,l)=>sum+BigInt(l.original_gross),0n)!==BigInt(p.captured_amount)
        || owned.reduce((sum,l)=>sum+BigInt(l.refunded),0n)!==BigInt(p.refunded_amount)) return 'Capture ownership, original evidence or historical payment totals require reconciliation';
    }
    const ids=payments.map(p=>p.id);
    const [row]=await tx<{conflict:boolean}[]>`select
      exists(select 1 from public.payment_attempts a where payment_id in ${tx(ids)} and kind='CAPTURE' and status='SUCCEEDED' and not exists(select 1 from public.capture_accounting_lots where capture_attempt_id=a.id))
      or exists(select 1 from public.refunds r where payment_id in ${tx(ids)} and
        ((select coalesce(sum(reserved_gross) filter(where status<>'RELEASED'),0) from public.refund_capture_allocations where refund_id=r.id)<>(case when r.status='FAILED' then 0 else r.amount end)
        or exists(select 1 from public.refund_capture_allocations a where refund_id=r.id and a.status<>(case when r.status='SUCCEEDED' then 'CONFIRMED' when r.status='FAILED' then 'RELEASED' else 'RESERVED' end))))
      or exists(select 1 from public.disputes d where payment_id in ${tx(ids)} and
        ((select coalesce(sum(gross_principal),0) from public.dispute_capture_allocations where dispute_id=d.id)<>d.amount
        or exists(select 1 from public.dispute_capture_allocations a where dispute_id=d.id and (a.status='PLANNED' or a.status<>d.status or a.outcome is distinct from d.outcome))))
      or exists(select 1 from public.settlement_items where payment_id in ${tx(ids)} and capture_lot_id is null) as conflict`;
    return row.conflict?'Unallocated legacy or contradictory refund/dispute/settlement evidence requires review':null;
  }
  private async checkInboxPrerequisites(tx:DbTransaction,ids:string[]):Promise<void> {
    const [row]=await tx`select w.id from public.webhook_events w where provider='STRIPE' and status in ('PENDING','PROCESSING','RETRY','DEAD')
      and payload->>'type' in ('refund.succeeded','dispute.opened','dispute.closed') and
      (payload->'data'->>'paymentId' in ${tx(ids)}
        or exists(select 1 from public.refunds r where r.payment_id in ${tx(ids)} and r.id::text=w.payload->'data'->>'refundId')
        or exists(select 1 from public.provider_transactions p where p.provider='STRIPE' and p.payment_id in ${tx(ids)} and
          (p.provider_transaction_id=w.payload->'data'->>'providerTransactionId' or p.payment_intent_id=w.payload->'data'->>'paymentIntentId' or p.charge_id=w.payload->'data'->>'chargeId'))) limit 1`;
    if(row) throw new DomainError('ACCOUNTING_PREREQUISITE_PENDING','Known confirmed provider evidence requires application/reconciliation before settlement',409);
  }
  private lines(scope:Scope,asset:bigint,release:bigint):LedgerLine[] {
    return [
      ...(asset?[{accountCode:'PLATFORM_CASH' as const,merchantId:null,debit:exactLedgerAmount(asset)},{accountCode:'PSP_CLEARING' as const,merchantId:null,credit:exactLedgerAmount(asset)}]:[]),
      ...(release?[{accountCode:'MERCHANT_PENDING' as const,merchantId:scope.merchant_id,debit:exactLedgerAmount(release)},{accountCode:'MERCHANT_AVAILABLE' as const,merchantId:scope.merchant_id,credit:exactLedgerAmount(release)}]:[]),
    ].sort((a,b)=>a.accountCode.localeCompare(b.accountCode));
  }
  private async validateReplay(tx:DbTransaction,batch:Batch,items:Item[],lots:Lot[]):Promise<void> {
    const invalid=()=>new DomainError('ACCOUNTING_INTEGRITY_CONFLICT','Finalized settlement evidence requires reconciliation',409);
    if(!['POSTED','ZERO_EFFECT'].includes(batch.finalization_result??'') || !batch.accounting_finalized_at) throw invalid();
    for(const item of items) {
      const lot=lots.find(l=>l.id===item.capture_lot_id);
      if(!lot?.verified || !this.candidateMatches(item,lot,batch) || lot.settlement_state!=='FINALIZED' || lot.finalized_settlement_item_id!==item.id
        || !item.accounting_finalized_at || item.applied_revision===null || BigInt(item.applied_revision)<BigInt(item.selected_revision)
        || BigInt(item.applied_revision)>BigInt(lot.allocation_revision) || item.finalized_asset_transfer===null || item.finalized_merchant_release===null) throw invalid();
      const positive=BigInt(item.finalized_asset_transfer)>0n || BigInt(item.finalized_merchant_release)>0n;
      if(item.finalization_result!==(positive?'POSTED':'ZERO_EFFECT') || item.accounting_journal_id!==(positive?batch.accounting_journal_id:null)) throw invalid();
    }
    for(const [itemField,batchField] of [['gross_amount','gross_amount'],['fee_amount','fee_amount'],['net_amount','net_amount'],
      ['estimated_asset_transfer','estimated_asset_transfer'],['estimated_merchant_release','estimated_merchant_release'],
      ['finalized_asset_transfer','finalized_asset_transfer'],['finalized_merchant_release','finalized_merchant_release']] as const)
      if(items.reduce((sum,i)=>sum+BigInt(i[itemField]!),0n)!==BigInt(batch[batchField]!)) throw invalid();
    const asset=BigInt(batch.finalized_asset_transfer!),release=BigInt(batch.finalized_merchant_release!);
    if(batch.finalization_result!==(asset || release?'POSTED':'ZERO_EFFECT')) throw invalid();
    const journals=await tx<{id:string;status:string;merchant_id:string;currency:string}[]>`select id,status,merchant_id,currency from public.ledger_transactions where business_type='SETTLEMENT' and business_id=${batch.id}`;
    if(batch.finalization_result==='ZERO_EFFECT') {if(batch.accounting_journal_id!==null || journals.length) throw invalid(); return;}
    if(journals.length!==1 || journals[0].id!==batch.accounting_journal_id || journals[0].status!=='POSTED' || journals[0].merchant_id!==batch.merchant_id || journals[0].currency!==batch.currency) throw invalid();
    const entries=await tx<{code:string;merchant_id:string|null;account_type:string;currency:string;debit:string;credit:string}[]>`select a.code,a.merchant_id,a.account_type,e.currency,
      sum(e.debit)::text as debit,sum(e.credit)::text as credit from public.ledger_entries e join public.ledger_accounts a on a.id=e.account_id
      where transaction_id=${batch.accounting_journal_id} group by a.code,a.merchant_id,a.account_type,e.currency order by a.code`;
    const expected=this.lines(batch,asset,release);
    if(entries.length!==expected.length || entries.some((e,i)=>e.code!==expected[i].accountCode || e.merchant_id!==expected[i].merchantId || e.currency!==batch.currency
      || e.account_type!==(e.code.startsWith('MERCHANT_')?'LIABILITY':'ASSET') || BigInt(e.debit)!==BigInt(expected[i].debit??0) || BigInt(e.credit)!==BigInt(expected[i].credit??0))) throw invalid();
  }
  private async review(tx:DbTransaction,scope:Scope,lots:Lot[],key:string,reason:string):Promise<Disposition> {
    const [created]=await tx<{id:string}[]>`insert into public.accounting_exceptions (merchant_id,currency,category,source_kind,evidence_key,observed_conflict)
      values (${scope.merchant_id},${scope.currency},'SETTLEMENT_ELIGIBILITY_CONFLICT','INTERNAL',${`settlement:${key}`},
        ${tx.json({reason,captures:lots.map(l=>({lotId:l.id,paymentId:l.payment_id,attemptId:l.capture_attempt_id,journalId:l.capture_journal_id}))})}) on conflict do nothing returning id`;
    if(created) await this.audit.append(tx,{merchantId:scope.merchant_id,actor:{type:'SYSTEM'},action:'settlement.accounting_exception',targetType:'accounting_exception',targetId:created.id,metadata:{reason,evidenceKey:`settlement:${key}`}});
    return 'ACCOUNTING_EXCEPTION';
  }
}
