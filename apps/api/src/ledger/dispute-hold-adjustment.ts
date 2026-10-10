import { randomUUID } from 'node:crypto';
import { DomainError } from '../common/domain-error';
import type { DbTransaction } from '../database/database.service';
import { LedgerService } from './ledger.service';

export function exactLedgerAmount(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError('LEDGER_AMOUNT_UNREPRESENTABLE', 'Exact accounting effect exceeds the existing Number ledger boundary', 409);
  return Number(value);
}

// Callers hold advisory/scope/payment, all intent parents and lots first.
// Keep original funding immutable; only append reductions caused by confirmed
// disjoint refund/loss evidence. A closing case is excluded from surviving holds.
export async function reduceDisputeHolds(tx: DbTransaction, ledger: LedgerService, input: {
  lotId: string; paymentId: string; merchantId: string; currency: string; settled: boolean;
  survivingEntitlement: bigint; inboxId: string; cause: 'REFUND' | 'DISPUTE'; causeId: string;
}): Promise<{ released: bigint; remaining: bigint }> {
  const holds = await tx<{ id: string; held: string }[]>`select a.id,(a.funded_hold+coalesce(e.delta,0))::text as held
    from public.dispute_capture_allocations a join public.disputes d on d.id=a.dispute_id
    left join lateral (select sum(hold_delta) as delta from public.dispute_hold_effects where allocation_id=a.id) e on true
    where a.capture_lot_id=${input.lotId} and a.status='OPEN'
      and (${input.cause === 'DISPUTE' ? input.causeId : null}::uuid is null or a.dispute_id<>${input.causeId}::uuid)
    order by d.opened_at,d.id,a.id`;
  let capacity = input.survivingEntitlement > 0n ? input.survivingEntitlement : 0n;
  let released = 0n; let remaining = 0n;
  for (const hold of holds) {
    const current = BigInt(hold.held);
    const funded = current < capacity ? current : capacity;
    const reduction = current - funded;
    capacity -= funded; remaining += funded;
    if (!reduction) continue;
    const effectId = randomUUID();
    const journal = await ledger.post(tx, { merchantId: input.merchantId, businessType: 'DISPUTE_HOLD_ADJUSTMENT', businessId: effectId,
      currency: input.currency, description: `Hold reduction for ${input.cause.toLowerCase()} ${input.causeId}`, lines: [
        { accountCode: 'DISPUTE_CLEARING', merchantId: input.merchantId, debit: exactLedgerAmount(reduction) },
        { accountCode: input.settled ? 'MERCHANT_AVAILABLE' : 'MERCHANT_PENDING', merchantId: input.merchantId, credit: exactLedgerAmount(reduction) },
      ] });
    await tx`insert into public.dispute_hold_effects
      (id,allocation_id,capture_lot_id,payment_id,merchant_id,currency,effect_key,hold_delta,journal_id,provider_event_id,cause_refund_id,cause_dispute_id)
      values (${effectId},${hold.id},${input.lotId},${input.paymentId},${input.merchantId},${input.currency},${`${input.cause.toLowerCase()}:${input.causeId}`},
        ${(-reduction).toString()},${journal},${input.inboxId},${input.cause === 'REFUND' ? input.causeId : null},${input.cause === 'DISPUTE' ? input.causeId : null})`;
    released += reduction;
  }
  return { released, remaining };
}
