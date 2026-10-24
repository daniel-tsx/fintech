export type SearchParams = Record<string, string | string[] | undefined>;
export type SortDir = 'asc' | 'desc';

export function param(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

/** Same path with the current query, `patch` applied (undefined removes a key). */
export function hrefWith(path: string, params: SearchParams, patch: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const key of Object.keys(params)) { const value = param(params, key); if (value) query.set(key, value); }
  for (const [key, value] of Object.entries(patch)) { if (value) query.set(key, value); else query.delete(key); }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** Case-insensitive substring match of `q` against any of the given field values. */
export function matches(q: string | undefined, values: Array<string | null | undefined>): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(needle));
}

/** Facet options with counts, in first-seen order. */
export function countBy<T>(rows: T[], pick: (row: T) => string): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(pick(row), (counts.get(pick(row)) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count }));
}

export function currentSort(params: SearchParams, defaultKey: string): { key: string; dir: SortDir } {
  return { key: param(params, 'sort') ?? defaultKey, dir: param(params, 'dir') === 'asc' ? 'asc' : 'desc' };
}

/**
 * Rows arrive newest first from the API, which is the default sort (`defaultKey` descending).
 * Other orders use `compare` (ascending); unknown keys keep the API order.
 */
export function sortRows<T>(rows: T[], params: SearchParams, defaultKey: string, compare: Record<string, (a: T, b: T) => number>): T[] {
  const { key, dir } = currentSort(params, defaultKey);
  const by = compare[key];
  if (!by || (key === defaultKey && dir === 'desc')) return rows;
  const sorted = [...rows].sort(by);
  return dir === 'desc' ? sorted.reverse() : sorted;
}

export const byTime = <T>(pick: (row: T) => string | null | undefined) => (a: T, b: T) => Date.parse(pick(a) ?? '') - Date.parse(pick(b) ?? '') || 0;

/** Money sorts within a currency: by currency code first, then exact minor units. */
export const byMoney = <T>(pick: (row: T) => { amount: string; currency: string }) => (a: T, b: T) => {
  const x = pick(a), y = pick(b);
  if (x.currency !== y.currency) return x.currency < y.currency ? -1 : 1;
  const p = BigInt(x.amount), q = BigInt(y.amount);
  return p === q ? 0 : p < q ? -1 : 1;
};
