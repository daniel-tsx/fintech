import type { DatabaseService, DbTransaction } from '../../src/database/database.service';
import { PaymentCommandHandlerService } from '../../src/payment-commands/payment-command-handler.service';
import type { PaymentProvider, ProviderOperationInput, ProviderResult } from '../../src/payment-provider/payment-provider.types';
import type { ProviderCommandEnvelope, ProviderCommandEventType } from '../../src/rabbitmq/rabbitmq.types';

describe('PaymentCommandHandlerService', () => {
  it.each([
    ['provider.authorization.requested', 'authorize'],
    ['provider.capture.requested', 'capture'],
    ['provider.refund.requested', 'refund'],
    ['provider.void.requested', 'cancel'],
  ] as const)('routes %s to PaymentProvider.%s()', async (eventType, method) => {
    const fixture = createFixture();
    await fixture.handler.execute(envelope(eventType));
    expect(fixture.calls[method]).toHaveLength(1);
    expect(fixture.calls[method][0]).toMatchObject({ idempotencyKey: 'capture:attempt-1' });
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
  });

  it('reuses the same provider idempotency key during duplicate consumer execution', async () => {
    const fixture = createFixture();
    const message = envelope('provider.capture.requested');

    await fixture.handler.execute(message);
    await fixture.handler.execute(message);

    expect(fixture.calls.capture.map((input) => input.idempotencyKey)).toEqual(['capture:attempt-1', 'capture:attempt-1']);
  });
});

function createFixture() {
  const result: ProviderResult = { providerObjectId: 'pi_123', paymentIntentId: 'pi_123', chargeId: 'ch_123', status: 'succeeded', metadata: {} };
  const calls: Record<'authorize' | 'capture' | 'refund' | 'cancel', ProviderOperationInput[]> = {
    authorize: [], capture: [], refund: [], cancel: [],
  };
  const provider: PaymentProvider = {
    authorize: (input) => { calls.authorize.push(input); return Promise.resolve(result); },
    capture: (input) => { calls.capture.push(input); return Promise.resolve(result); },
    refund: (input) => { calls.refund.push(input); return Promise.resolve({ ...result, providerObjectId: 're_123' }); },
    cancel: (input) => { calls.cancel.push(input); return Promise.resolve(result); },
    fetchStatus: () => Promise.resolve(null),
  };
  const tx = Object.assign(jest.fn().mockResolvedValue([]), { json: (value: unknown) => value }) as unknown as DbTransaction;
  const transaction = jest.fn(async (work: (transaction: DbTransaction) => Promise<void>) => work(tx));
  const database = {
    transaction,
  } as unknown as DatabaseService;
  return { handler: new PaymentCommandHandlerService(database, provider), calls, transaction };
}

function envelope(eventType: ProviderCommandEventType): ProviderCommandEnvelope {
  return {
    id: 'outbox-1', eventType, aggregateId: 'attempt-1', correlationId: 'attempt-1', createdAt: '2026-09-21T00:00:00.000Z',
    payload: {
      merchantId: 'merchant-1', paymentId: 'payment-1', attemptId: 'attempt-1', refundId: 'refund-1', amount: 4200,
      currency: 'USD', paymentMethodToken: 'pm_123', providerPaymentId: 'pi_123', idempotencyKey: 'capture:attempt-1',
    },
  };
}
