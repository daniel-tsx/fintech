// Stripe's currency exponents (the provider defines what a minor unit is); every other currency uses 2.
const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const threeDecimal = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
const grouping = new Intl.NumberFormat('en-US');

/** Minor units → decimal string, exactly: string arithmetic and BigInt, never floating point. */
export function formatAmount(minor: string | number, currency: string): string {
  const raw = String(minor);
  const match = /^(-?)(\d+)$/.exec(raw);
  if (!match) return raw;
  const [, sign, digits] = match;
  const exponent = zeroDecimal.has(currency) ? 0 : threeDecimal.has(currency) ? 3 : 2;
  const padded = digits.padStart(exponent + 1, '0');
  const whole = grouping.format(BigInt(padded.slice(0, padded.length - exponent)));
  return exponent ? `${sign}${whole}.${padded.slice(-exponent)}` : `${sign}${whole}`;
}

/** "USD 1,234.56": the ISO code avoids ambiguous symbols such as ¥ or $. */
export function formatMoney(minor: string | number, currency: string): string {
  return `${currency} ${formatAmount(minor, currency)}`;
}

/** One timestamp format everywhere: "2026-10-24 07:15:36 UTC". */
export function formatTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}
