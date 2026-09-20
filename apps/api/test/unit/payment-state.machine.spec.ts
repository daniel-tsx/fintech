import { PaymentStateMachine } from '../../src/payments/payment-state.machine';

describe('PaymentStateMachine', () => {
  it('supports authorize then capture', () => {
    const pending = PaymentStateMachine.authorizationRequested('CREATED');
    const authorized = PaymentStateMachine.authorized(pending);
    const capturePending = PaymentStateMachine.captureRequested(authorized, 1_000);
    expect(PaymentStateMachine.captureSucceeded(capturePending)).toBe('CAPTURED');
  });

  it('rejects capture before authorization', () => {
    expect(() => PaymentStateMachine.captureRequested('CREATED', 1_000)).toThrow('Cannot capture');
  });

  it('returns a partially captured payment to captured after a failed additional capture', () => {
    expect(PaymentStateMachine.captureFailed('CAPTURE_PENDING', 500)).toBe('CAPTURED');
  });

  it('moves cumulative refunds through partial to full', () => {
    expect(PaymentStateMachine.refundSucceeded('CAPTURED', 400, 1_000)).toBe('PARTIALLY_REFUNDED');
    expect(PaymentStateMachine.refundSucceeded('PARTIALLY_REFUNDED', 1_000, 1_000)).toBe('REFUNDED');
  });
});
