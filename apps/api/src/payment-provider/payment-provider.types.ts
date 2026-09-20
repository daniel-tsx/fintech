export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export type ProviderScenario =
  | 'SUCCESS' | 'DECLINE' | 'TIMEOUT_BEFORE_PROCESSING' | 'PROCESSED_RESPONSE_LOST'
  | 'DELAYED_WEBHOOK' | 'DUPLICATE_WEBHOOK' | 'OUT_OF_ORDER_WEBHOOK' | 'TEMPORARY_500'
  | 'REFUND_RETRY_THEN_SUCCESS' | 'AMOUNT_MISMATCH' | 'UNEXPECTED_TRANSACTION';

export interface ProviderOperationInput {
  merchantId: string;
  paymentId: string;
  attemptId?: string;
  refundId?: string;
  amount: number;
  currency: string;
  paymentMethodToken?: string;
  idempotencyKey: string;
  scenario: ProviderScenario;
  attemptNumber: number;
}

export interface ProviderResult { providerTransactionId: string; status: string }
export interface ProviderReportRow extends ProviderResult { paymentId: string | null; operation: string; amount: number; currency: string; merchantId: string }

export interface PaymentProvider {
  authorize(input: ProviderOperationInput): Promise<ProviderResult>;
  capture(input: ProviderOperationInput): Promise<ProviderResult>;
  cancel(input: ProviderOperationInput): Promise<ProviderResult>;
  refund(input: ProviderOperationInput): Promise<ProviderResult>;
  fetchTransactionStatus(providerTransactionId: string): Promise<ProviderResult | null>;
  report(): Promise<ProviderReportRow[]>;
}

export class RetryableProviderError extends Error {}
export class UnknownProviderOutcomeError extends Error {}
