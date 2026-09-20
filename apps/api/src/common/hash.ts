import { createHash } from 'node:crypto';

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalizeValue(item)]));
  }
  return value;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function requestHash(payload: unknown): string {
  return sha256(JSON.stringify(canonicalizeValue(payload)));
}
