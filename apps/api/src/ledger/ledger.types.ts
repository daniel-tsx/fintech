export type LedgerAccountCode =
  | 'PSP_CLEARING' | 'PLATFORM_CASH' | 'MERCHANT_PENDING' | 'MERCHANT_AVAILABLE'
  | 'PLATFORM_FEE_REVENUE' | 'PLATFORM_FEE_REFUNDS' | 'PAYOUT_CLEARING' | 'DISPUTE_CLEARING';

export interface LedgerLine {
  accountCode: LedgerAccountCode;
  merchantId: string | null;
  debit?: number;
  credit?: number;
}

export interface JournalInput {
  merchantId: string | null;
  businessType: string;
  businessId: string;
  currency: string;
  description: string;
  lines: LedgerLine[];
}

export function assertBalanced(lines: LedgerLine[]): void {
  if (lines.length < 2) throw new Error('A journal requires at least two entries');
  const debit = lines.reduce((sum, line) => sum + (line.debit ?? 0), 0);
  const credit = lines.reduce((sum, line) => sum + (line.credit ?? 0), 0);
  if (debit !== credit || debit <= 0) throw new Error(`Unbalanced journal: debit=${debit}, credit=${credit}`);
  for (const line of lines) {
    const sides = Number((line.debit ?? 0) > 0) + Number((line.credit ?? 0) > 0);
    if (sides !== 1 || !Number.isSafeInteger(line.debit ?? line.credit)) throw new Error('Each ledger line must contain one positive integer side');
  }
}

export function allocateRefundFee(totalFee: number, cumulativeRefund: number, capturedAmount: number, alreadyAllocated: number): number {
  if (![totalFee, cumulativeRefund, capturedAmount, alreadyAllocated].every(Number.isSafeInteger) || capturedAmount <= 0) throw new Error('Fee allocation requires safe integer minor units');
  return Math.floor((totalFee * cumulativeRefund) / capturedAmount) - alreadyAllocated;
}
