export interface MockPspEventData {
  merchantId: string;
  paymentId: string;
  attemptId?: string;
  refundId?: string;
  settlementId?: string;
  providerTransactionId: string;
  providerDisputeId?: string;
  amount: number;
  currency: string;
  status?: string;
  outcome?: 'MERCHANT_WON' | 'MERCHANT_LOST';
}

export interface MockPspEvent { id: string; type: string; createdAt: string; data: MockPspEventData }
export class RetryableWebhookError extends Error {}

function optionalString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }

export function parseMockPspEvent(value: unknown): MockPspEvent {
  if (value === null || typeof value !== 'object') throw new Error('Event must be an object');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.length > 255 || typeof candidate.type !== 'string' || candidate.type.length > 255 || typeof candidate.createdAt !== 'string') throw new Error('Event envelope fields are invalid');
  if (candidate.data === null || typeof candidate.data !== 'object') throw new Error('Event data must be an object');
  const data = candidate.data as Record<string, unknown>;
  if (typeof data.merchantId !== 'string' || typeof data.paymentId !== 'string' || typeof data.providerTransactionId !== 'string') throw new Error('Event identity fields are invalid');
  if (!Number.isSafeInteger(data.amount) || Number(data.amount) < 0 || typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency)) throw new Error('Event money fields are invalid');
  const outcome = optionalString(data.outcome);
  if (outcome && outcome !== 'MERCHANT_WON' && outcome !== 'MERCHANT_LOST') throw new Error('Event dispute outcome is invalid');
  return {
    id: candidate.id, type: candidate.type, createdAt: candidate.createdAt,
    data: {
      merchantId: data.merchantId, paymentId: data.paymentId, providerTransactionId: data.providerTransactionId,
      amount: Number(data.amount), currency: data.currency, attemptId: optionalString(data.attemptId), refundId: optionalString(data.refundId),
      settlementId: optionalString(data.settlementId), providerDisputeId: optionalString(data.providerDisputeId), status: optionalString(data.status),
      outcome: outcome as MockPspEventData['outcome'],
    },
  };
}
