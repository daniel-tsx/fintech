export type Tone = 'authorized' | 'captured' | 'settled' | 'paid' | 'refunded' | 'pending' | 'attention' | 'failed' | 'done' | 'neutral';
export type StatusOf = 'attempt' | 'refund' | 'settlement' | 'payout' | 'severity';

export const glyphs: Record<Tone, string> = { authorized: '○', captured: '◐', settled: '●', paid: '■', refunded: '↺', pending: '…', attention: '▲', failed: '✕', done: '✓', neutral: '—' };

const tones: Record<string, Tone> = {
  AUTHORIZED: 'authorized', CAPTURED: 'captured', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'refunded',
  CREATED: 'neutral', REQUIRES_AUTHORIZATION: 'pending', CAPTURE_PENDING: 'pending', PENDING: 'pending', PROCESSING: 'pending', IN_PROGRESS: 'pending',
  DISPUTED: 'attention', OPEN: 'attention', RETRY: 'attention', ACCOUNTING_EXCEPTION: 'attention',
  FAILED: 'failed', DEAD: 'failed', MERCHANT_LOST: 'failed',
  SUCCEEDED: 'done', PROCESSED: 'done', POSTED: 'done', PUBLISHED: 'done', RESOLVED: 'done', CLOSED: 'done', MERCHANT_WON: 'done',
};

/**
 * One status system for every page. `of` names the record when the raw value alone is ambiguous:
 * SUCCEEDED means "settled" for a settlement and "paid out" for a payout, and those must never look like a capture.
 */
export function describeStatus(value: string, of?: StatusOf): { tone: Tone; label: string } {
  const label = value.replaceAll('_', ' ').toLowerCase();
  if (value === 'SUCCEEDED' && of === 'settlement') return { tone: 'settled', label: 'settled' };
  if (value === 'SUCCEEDED' && of === 'payout') return { tone: 'paid', label: 'paid out' };
  if (value === 'SUCCEEDED' && of === 'refund') return { tone: 'refunded', label: 'refunded' };
  if (value === 'PROCESSING' && (of === 'attempt' || of === 'refund')) return { tone: 'pending', label: 'processing · outcome unknown' };
  if (of === 'severity') return { tone: value === 'HIGH' || value === 'CRITICAL' ? 'attention' : 'neutral', label };
  return { tone: tones[value] ?? 'neutral', label };
}
