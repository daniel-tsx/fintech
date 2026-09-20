const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1';
const API_KEY = process.env.DEMO_API_KEY ?? 'fl_test_demo_6f414a845fe04eb4';

export class ApiUnavailableError extends Error {}

export async function api<T>(path: string): Promise<T> {
  try {
    const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers: { 'x-api-key': API_KEY } });
    if (!response.ok) throw new ApiUnavailableError(`API returned ${response.status}`);
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ApiUnavailableError) throw error;
    throw new ApiUnavailableError('The local API is not reachable. Start PostgreSQL, Redis, the API, and the worker.');
  }
}

export function formatMoney(value: string | number, currency: string): string {
  const minor = Number(value);
  const zeroDecimal = new Set(['VND', 'JPY', 'KRW']);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: zeroDecimal.has(currency) ? 0 : 2 }).format(minor / (zeroDecimal.has(currency) ? 1 : 100));
}

export function formatTime(value?: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
}
