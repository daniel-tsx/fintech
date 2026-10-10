// Allocation contract; B2.2's gated refund service is not connected to runtime.
export const CAPTURE_ACCOUNTING_POLICY = 'CAPTURE_FIFO_V1';
const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;

export interface AllocationScope { merchantId: string; paymentId: string; currency: string }
export interface AllocationLot extends AllocationScope {
  id: string;
  captureAttemptId: string;
  financialCapturedAtMicros: bigint;
  originalGross: bigint;
  originalFee: bigint;
  confirmedRefundGross: bigint;
  reservedRefundGross: bigint;
  activeDisputeGross: bigint;
  lostDisputeGross: bigint;
}
export interface FrozenRefundAllocation { refundId: string; lotId: string; gross: bigint }

function minorUnits(value: bigint, name: string, positive = false): void {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > MAX_MINOR_UNITS) {
    throw new Error(`${name} must be ${positive ? 'positive' : 'non-negative'} bigint minor units`);
  }
}

export function remainingCaptureCapacity(lot: AllocationLot): bigint {
  minorUnits(lot.originalGross, 'Capture gross', true);
  minorUnits(lot.originalFee, 'Capture fee');
  if (lot.originalFee > lot.originalGross) throw new Error('Capture fee exceeds gross');
  for (const amount of [lot.confirmedRefundGross, lot.reservedRefundGross, lot.activeDisputeGross, lot.lostDisputeGross]) {
    minorUnits(amount, 'Consumed or reserved principal');
  }
  const remaining = lot.originalGross - lot.confirmedRefundGross - lot.reservedRefundGross - lot.activeDisputeGross - lot.lostDisputeGross;
  if (remaining < 0n) throw new Error('Conflicting allocations exceed capture principal');
  return remaining;
}

export function captureRefundFeeDelta(input: {
  originalGross: bigint; originalFee: bigint; previousConfirmedGross: bigint;
  cumulativeConfirmedGross: bigint; previousConfirmedFee: bigint;
}): bigint {
  minorUnits(input.originalGross, 'Capture gross', true);
  for (const amount of [input.originalFee, input.previousConfirmedGross, input.cumulativeConfirmedGross, input.previousConfirmedFee]) {
    minorUnits(amount, 'Fee allocation input');
  }
  if (input.originalFee > input.originalGross || input.previousConfirmedGross > input.cumulativeConfirmedGross || input.cumulativeConfirmedGross > input.originalGross) {
    throw new Error('Fee allocation exceeds capture bounds');
  }
  const previousFee = input.originalFee * input.previousConfirmedGross / input.originalGross;
  if (previousFee !== input.previousConfirmedFee) throw new Error('Previous confirmed fee does not reconcile');
  return input.originalFee * input.cumulativeConfirmedGross / input.originalGross - previousFee;
}

export function allocateRefundFifo(input: AllocationScope & {
  refundId: string; gross: bigint; lots: readonly AllocationLot[];
  existing?: readonly FrozenRefundAllocation[];
}): FrozenRefundAllocation[] {
  minorUnits(input.gross, 'Refund gross', true);
  if (!input.refundId || !input.merchantId || !input.paymentId || !/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error('Refund allocation requires an identified merchant/payment/currency');
  }
  const lots = new Map<string, AllocationLot>();
  const attempts = new Set<string>();
  for (const lot of input.lots) {
    if (lot.merchantId !== input.merchantId || lot.paymentId !== input.paymentId || lot.currency !== input.currency) {
      throw new Error('Capture allocation ownership or currency mismatch');
    }
    if (!lot.id || !lot.captureAttemptId || lots.has(lot.id) || attempts.has(lot.captureAttemptId)) throw new Error('Duplicate or missing capture identity');
    if (typeof lot.financialCapturedAtMicros !== 'bigint') throw new Error('Capture chronology requires exact epoch microseconds');
    remainingCaptureCapacity(lot);
    lots.set(lot.id, lot); attempts.add(lot.captureAttemptId);
  }
  // A replay uses the persisted assignments even after new captures or consumption.
  if (input.existing !== undefined) {
    const seen = new Set<string>();
    let total = 0n;
    for (const allocation of input.existing) {
      const lot = lots.get(allocation.lotId);
      minorUnits(allocation.gross, 'Frozen refund gross', true);
      if (allocation.refundId !== input.refundId || !lot || seen.has(allocation.lotId) || allocation.gross > lot.originalGross) {
        throw new Error('Frozen refund allocation identity mismatch');
      }
      seen.add(allocation.lotId); total += allocation.gross;
    }
    if (total !== input.gross) throw new Error('Frozen refund payload mismatch');
    return input.existing.map((allocation) => ({ ...allocation }));
  }
  const ordered = [...lots.values()].sort((a, b) => {
    if (a.financialCapturedAtMicros !== b.financialCapturedAtMicros) return a.financialCapturedAtMicros < b.financialCapturedAtMicros ? -1 : 1;
    return a.captureAttemptId < b.captureAttemptId ? -1 : a.captureAttemptId > b.captureAttemptId ? 1 : 0;
  });
  const allocations: FrozenRefundAllocation[] = [];
  let remaining = input.gross;
  for (const lot of ordered) {
    const capacity = remainingCaptureCapacity(lot);
    const gross = capacity < remaining ? capacity : remaining;
    if (gross > 0n) allocations.push({ refundId: input.refundId, lotId: lot.id, gross });
    remaining -= gross;
    if (remaining === 0n) return allocations;
  }
  throw new Error('Insufficient unallocated capture principal');
}
