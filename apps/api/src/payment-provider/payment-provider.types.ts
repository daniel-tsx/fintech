export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

export type ProviderOperation = 'AUTHORIZE' | 'CAPTURE' | 'VOID' | 'REFUND';
export type ProviderObjectType = 'PAYMENT_INTENT' | 'REFUND';

export interface ProviderOperationInput {
  merchantId: string;
  paymentId: string;
  attemptId?: string;
  refundId?: string;
  amount: number;
  currency: string;
  paymentMethodToken?: string;
  providerPaymentId?: string;
  finalCapture?: boolean;
  idempotencyKey: string;
}

export interface ProviderResult {
  providerObjectId: string;
  paymentIntentId?: string;
  chargeId?: string;
  status: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface ProviderStatusQuery {
  objectType: ProviderObjectType;
  providerObjectId: string;
}

export interface ProviderStatus extends ProviderResult {
  amount: number;
  capturedAmount?: number;
  currency: string;
}

export interface PaymentProvider {
  authorize(input: ProviderOperationInput): Promise<ProviderResult>;
  capture(input: ProviderOperationInput): Promise<ProviderResult>;
  cancel(input: ProviderOperationInput): Promise<ProviderResult>;
  refund(input: ProviderOperationInput): Promise<ProviderResult>;
  fetchStatus(query: ProviderStatusQuery): Promise<ProviderStatus | null>;
}

export class RetryableProviderError extends Error {}
export class UnknownProviderOutcomeError extends Error {}
export class PermanentProviderError extends Error {}
