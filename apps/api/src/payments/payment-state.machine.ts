import { DomainError } from '../common/domain-error';

export type PaymentStatus =
  | 'CREATED' | 'REQUIRES_AUTHORIZATION' | 'AUTHORIZED' | 'CAPTURE_PENDING' | 'CAPTURED'
  | 'FAILED' | 'CANCELLED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'DISPUTED';

function requireState(current: PaymentStatus, operation: string, allowed: PaymentStatus[]): void {
  if (!allowed.includes(current)) throw new DomainError('INVALID_PAYMENT_TRANSITION', `Cannot ${operation} a payment in ${current}`, 409, { current, allowed });
}

export const PaymentStateMachine = {
  authorizationRequested(current: PaymentStatus): PaymentStatus {
    requireState(current, 'request authorization for', ['CREATED']);
    return 'REQUIRES_AUTHORIZATION';
  },
  authorized(current: PaymentStatus): PaymentStatus {
    requireState(current, 'confirm authorization for', ['REQUIRES_AUTHORIZATION']);
    return 'AUTHORIZED';
  },
  authorizationFailed(current: PaymentStatus): PaymentStatus {
    requireState(current, 'fail authorization for', ['REQUIRES_AUTHORIZATION']);
    return 'FAILED';
  },
  captureRequested(current: PaymentStatus, remaining: number): PaymentStatus {
    requireState(current, 'capture', ['AUTHORIZED', 'CAPTURED']);
    if (remaining <= 0) throw new DomainError('NOTHING_TO_CAPTURE', 'The authorized amount has already been fully captured', 409);
    return 'CAPTURE_PENDING';
  },
  captureSucceeded(current: PaymentStatus): PaymentStatus {
    requireState(current, 'confirm capture for', ['CAPTURE_PENDING']);
    return 'CAPTURED';
  },
  captureFailed(current: PaymentStatus, capturedAmount: number): PaymentStatus {
    requireState(current, 'fail capture for', ['CAPTURE_PENDING']);
    return capturedAmount > 0 ? 'CAPTURED' : 'AUTHORIZED';
  },
  refundSucceeded(current: PaymentStatus, refundedAmount: number, capturedAmount: number): PaymentStatus {
    requireState(current, 'refund', ['CAPTURED', 'PARTIALLY_REFUNDED']);
    if (refundedAmount <= 0 || refundedAmount > capturedAmount) throw new DomainError('INVALID_REFUND_TOTAL', 'Refund total must be positive and cannot exceed captured amount');
    return refundedAmount === capturedAmount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  },
  disputeOpened(current: PaymentStatus): PaymentStatus {
    requireState(current, 'open a dispute for', ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
    return 'DISPUTED';
  },
  cancelled(current: PaymentStatus): PaymentStatus {
    requireState(current, 'cancel', ['CREATED', 'REQUIRES_AUTHORIZATION', 'AUTHORIZED']);
    return 'CANCELLED';
  },
};
