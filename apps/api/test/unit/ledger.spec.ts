import { allocateRefundFee, assertBalanced } from '../../src/ledger/ledger.types';

describe('ledger invariants', () => {
  it('accepts a balanced capture journal', () => {
    expect(() => assertBalanced([
      { accountCode: 'PSP_CLEARING', merchantId: null, debit: 10_000 },
      { accountCode: 'MERCHANT_PENDING', merchantId: 'merchant', credit: 9_700 },
      { accountCode: 'PLATFORM_FEE_REVENUE', merchantId: null, credit: 300 },
    ])).not.toThrow();
  });

  it('rejects an unbalanced journal', () => {
    expect(() => assertBalanced([
      { accountCode: 'PSP_CLEARING', merchantId: null, debit: 10_000 },
      { accountCode: 'MERCHANT_PENDING', merchantId: 'merchant', credit: 9_700 },
    ])).toThrow('Unbalanced journal');
  });

  it('allocates the final rounding unit across partial refunds exactly', () => {
    const first = allocateRefundFee(101, 333, 1_000, 0);
    const second = allocateRefundFee(101, 666, 1_000, first);
    const last = allocateRefundFee(101, 1_000, 1_000, first + second);
    expect(first + second + last).toBe(101);
  });
});
