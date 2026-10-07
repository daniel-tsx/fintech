import { DomainError } from '../../src/common/domain-error';
import { PaymentCommandConsumer } from '../../src/payment-commands/payment-command.consumer';
import type { PaymentCommandHandlerService } from '../../src/payment-commands/payment-command-handler.service';
import { PermanentProviderError, RetryableProviderError, UnknownProviderOutcomeError } from '../../src/payment-provider/payment-provider.types';
import type { BrokerDelivery, CommandBroker, ProviderCommandEnvelope } from '../../src/rabbitmq/rabbitmq.types';

describe('PaymentCommandConsumer', () => {
  it('returns ACK only after the command handler completes durable local processing', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const consumer = createConsumer(execute);

    await expect(consumer.handle(delivery())).resolves.toEqual({ action: 'ACK' });
    expect(execute).toHaveBeenCalledWith(envelope());
  });

  it.each([
    new RetryableProviderError('rate limited'),
    new UnknownProviderOutcomeError('response lost'),
    new Error('temporary database failure'),
  ])('sends transient and unknown outcomes through the retry queue', async (error) => {
    const consumer = createConsumer(jest.fn().mockRejectedValue(error));
    await expect(consumer.handle(delivery())).resolves.toEqual({ action: 'RETRY', reason: error.message });
  });

  it.each([
    new PermanentProviderError('invalid PaymentIntent'),
    new DomainError('INVALID_COMMAND', 'invalid command', 422),
  ])('dead-letters permanent failures without immediate requeue', async (error) => {
    const consumer = createConsumer(jest.fn().mockRejectedValue(error));
    await expect(consumer.handle(delivery())).resolves.toEqual({ action: 'DEAD_LETTER', reason: error.message });
  });

  it('dead-letters malformed messages', async () => {
    const consumer = createConsumer(jest.fn());
    await expect(consumer.handle({ ...delivery(), body: { invalid: true } })).resolves.toMatchObject({ action: 'DEAD_LETTER' });
  });

  it('dead-letters a retryable command after the eighth delivery attempt', async () => {
    const consumer = createConsumer(jest.fn().mockRejectedValue(new RetryableProviderError('still unavailable')));
    await expect(consumer.handle({ ...delivery(), retryCount: 7 })).resolves.toEqual({ action: 'DEAD_LETTER', reason: 'still unavailable' });
  });
});

function createConsumer(execute: jest.Mock): PaymentCommandConsumer {
  const broker = { consumeProviderCommands: jest.fn() } as unknown as CommandBroker;
  return new PaymentCommandConsumer(broker, { execute } as unknown as PaymentCommandHandlerService);
}

function delivery(): BrokerDelivery {
  return { body: envelope(), messageId: 'outbox-1', correlationId: 'attempt-1', routingKey: 'provider.capture.requested', retryCount: 0 };
}

function envelope(): ProviderCommandEnvelope {
  return {
    id: 'outbox-1', eventType: 'provider.capture.requested', aggregateId: 'attempt-1', correlationId: 'attempt-1',
    createdAt: '2026-09-21T00:00:00.000Z',
    payload: { merchantId: 'merchant-1', paymentId: 'payment-1', attemptId: 'attempt-1', amount: 4200, currency: 'USD', providerPaymentId: 'pi_123', idempotencyKey: 'capture:attempt-1' },
  };
}
