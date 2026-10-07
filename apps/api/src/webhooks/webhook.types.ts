export type InternalProviderEventType =
  | 'payment.authorized'
  | 'payment.authorization_failed'
  | 'payment.capture_succeeded'
  | 'payment.capture_failed'
  | 'payment.cancelled'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'dispute.opened'
  | 'dispute.closed';

export interface ProviderEventData {
  merchantId?: string;
  paymentId?: string;
  attemptId?: string;
  refundId?: string;
  providerTransactionId: string;
  paymentIntentId?: string;
  chargeId?: string;
  providerDisputeId?: string;
  amount: number;
  currency: string;
  providerStatus?: string;
  outcome?: 'MERCHANT_WON' | 'MERCHANT_LOST';
}

export interface ProviderEvent {
  id: string;
  type: InternalProviderEventType | 'provider.unsupported';
  externalType: string;
  createdAt: string;
  data: ProviderEventData | null;
}

export interface CorrelatedProviderEvent extends ProviderEvent {
  type: InternalProviderEventType;
  data: ProviderEventData & { merchantId: string; paymentId: string };
}

export class RetryableWebhookError extends Error {}
