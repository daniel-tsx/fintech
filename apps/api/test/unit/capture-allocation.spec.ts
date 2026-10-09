import { allocateRefundFifo, captureRefundFeeDelta, remainingCaptureCapacity, type AllocationLot } from '../../src/ledger/capture-allocation';

const scope = { merchantId: 'merchant', paymentId: 'payment', currency: 'USD' };
function lot(id = 'a', gross = 10000n, fee = 300n, time = 1000n): AllocationLot {
  return { ...scope, id, captureAttemptId: id, financialCapturedAtMicros: time, originalGross: gross, originalFee: fee,
    confirmedRefundGross: 0n, reservedRefundGross: 0n, activeDisputeGross: 0n, lostDisputeGross: 0n };
}
function allocate(lots: AllocationLot[], gross: bigint) {
  return allocateRefundFifo({ ...scope, refundId: 'refund', gross, lots });
}

describe('capture-owned allocation foundation (not runtime integrated)', () => {
  it('allocates a partial and full single-capture refund', () => {
    expect(allocate([lot()], 5000n)).toEqual([{ refundId: 'refund', lotId: 'a', gross: 5000n }]);
    expect(allocate([lot()], 10000n)[0].gross).toBe(10000n);
  });
  it('sorts FIFO and splits the mixed-capture example', () => {
    expect(allocate([lot('b', 6000n, 180n, 2000n), lot('a', 4000n, 120n)], 5000n)).toEqual([
      { refundId: 'refund', lotId: 'a', gross: 4000n }, { refundId: 'refund', lotId: 'b', gross: 1000n },
    ]);
  });
  it('uses attempt identity for equal microsecond timestamps', () => {
    expect(allocate([lot('b', 500n, 0n), lot('a', 500n, 0n)], 600n).map((a) => [a.lotId,a.gross])).toEqual([['a',500n],['b',100n]]);
  });
  it('preserves sub-millisecond ordering and does not mutate the input', () => {
    const lots = [lot('a', 500n, 0n, 1001n), lot('b', 500n, 0n, 1000n)];
    expect(allocate(lots, 500n)[0].lotId).toBe('b'); expect(lots[0].id).toBe('a');
  });
  it('subtracts confirmed, reserved, disputed and lost principal once', () => {
    const capture = { ...lot(), confirmedRefundGross: 2000n, reservedRefundGross: 1000n, activeDisputeGross: 3000n, lostDisputeGross: 1000n };
    expect(remainingCaptureCapacity(capture)).toBe(3000n);
    expect(() => allocate([capture], 3001n)).toThrow('Insufficient');
  });
  it('rejects exhausted and inconsistent capacity', () => {
    expect(() => allocate([{ ...lot(), reservedRefundGross: 10000n }], 1n)).toThrow('Insufficient');
    expect(() => remainingCaptureCapacity({ ...lot(), reservedRefundGross: 10001n })).toThrow('Conflicting');
  });
  it('replays frozen assignments without reallocating to later captures', () => {
    const existing = allocate([lot('b', 5000n, 100n)], 5000n);
    expect(allocateRefundFifo({ ...scope, refundId: 'refund', gross: 5000n, existing,
      lots: [{ ...lot('b', 5000n, 100n), reservedRefundGross: 5000n }, lot('a', 5000n, 0n, 500n)] })).toEqual(existing);
  });
  it('rejects changed replay payload and duplicate assignment identities', () => {
    const existing = allocate([lot()], 5000n);
    expect(() => allocateRefundFifo({ ...scope, refundId: 'refund', gross: 5001n, lots: [lot()], existing })).toThrow('payload');
    expect(() => allocateRefundFifo({ ...scope, refundId: 'refund', gross: 10000n, lots: [lot()], existing: [...existing,...existing] })).toThrow('identity');
    expect(() => allocate([lot(),lot()], 1n)).toThrow('Duplicate');
  });
  it.each(['merchantId','paymentId','currency'] as const)('rejects cross-scope %s', (key) => {
    expect(() => allocate([{ ...lot(), [key]: 'other' }], 1n)).toThrow('ownership');
  });
  it('returns cumulative capture fees 33,34,34 for three refunds', () => {
    let gross = 0n, fee = 0n;
    const deltas = [333n,333n,334n].map((refund) => {
      const delta = captureRefundFeeDelta({ originalGross: 1000n, originalFee: 101n, previousConfirmedGross: gross,
        cumulativeConfirmedGross: gross + refund, previousConfirmedFee: fee });
      gross += refund; fee += delta; return delta;
    });
    expect(deltas).toEqual([33n,34n,34n]); expect(fee).toBe(101n);
  });
  it('implements the approved capture-level fixed-fee policy', () => {
    expect(captureRefundFeeDelta({ originalGross: 5000n, originalFee: 100n, previousConfirmedGross: 0n,
      cumulativeConfirmedGross: 5000n, previousConfirmedFee: 0n })).toBe(100n);
    expect(allocate([lot('a',5000n,100n),lot('b',5000n,0n,2000n)],5000n)).toHaveLength(1);
  });
  it('uses exact products beyond safe Number and bigint-column multiplication', () => {
    const max = 9_223_372_036_854_775_807n;
    expect(captureRefundFeeDelta({ originalGross: max, originalFee: max - 1n, previousConfirmedGross: 0n,
      cumulativeConfirmedGross: max - 1n, previousConfirmedFee: 0n })).toBe(max - 2n);
  });
  it('returns the exact review counterexample fee and final remainder at bigint bounds', () => {
    const originalGross = 9223372036854775807n, originalFee = 9223372036854775806n;
    const firstGross = 4611686018427387903n;
    const firstFee = captureRefundFeeDelta({originalGross,originalFee,previousConfirmedGross:0n,cumulativeConfirmedGross:firstGross,previousConfirmedFee:0n});
    expect(firstFee).toBe(4611686018427387902n);
    const secondFee = captureRefundFeeDelta({originalGross,originalFee,previousConfirmedGross:firstGross,cumulativeConfirmedGross:firstGross*2n,previousConfirmedFee:firstFee});
    expect(secondFee).toBe(4611686018427387903n);
    expect(captureRefundFeeDelta({originalGross,originalFee,previousConfirmedGross:firstGross*2n,cumulativeConfirmedGross:originalGross,previousConfirmedFee:firstFee+secondFee})).toBe(1n);
  });
  it('rejects unsafe representations, nonpositive refunds and invalid fee history', () => {
    expect(() => allocate([lot()], 0n)).toThrow('positive');
    expect(() => allocate([lot()], 10 as unknown as bigint)).toThrow('bigint');
    expect(() => remainingCaptureCapacity(lot('a',100n,101n))).toThrow('fee exceeds');
    expect(() => captureRefundFeeDelta({ originalGross: 1000n, originalFee: 101n, previousConfirmedGross: 333n,
      cumulativeConfirmedGross: 666n, previousConfirmedFee: 32n })).toThrow('reconcile');
  });
});
