import type { ConfigService } from '@nestjs/config';
import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { AmqpConnect, RabbitMqService } from '../../src/rabbitmq/rabbitmq.service';
import { COMMANDS_DEAD_EXCHANGE, COMMANDS_RETRY_EXCHANGE } from '../../src/rabbitmq/rabbitmq.types';

describe('RabbitMqService acknowledgement boundary', () => {
  it('ACKs the original delivery after the consumer reports durable success', async () => {
    const fixture = brokerFixture();
    await fixture.service.consumeProviderCommands(() => Promise.resolve({ action: 'ACK' }));

    fixture.deliver(message());
    await settle();

    expect(fixture.acknowledgements).toHaveLength(1);
    expect(fixture.publications).toHaveLength(0);
  });

  it('confirm-publishes retry and dead-letter copies before ACKing the original delivery', async () => {
    const retry = brokerFixture();
    await retry.service.consumeProviderCommands(() => Promise.resolve({ action: 'RETRY', reason: 'temporary provider error' }));
    retry.deliver(message());
    await settle();
    expect(retry.publications[0]).toMatchObject({
      exchange: COMMANDS_RETRY_EXCHANGE,
      routingKey: 'provider.capture.requested',
      options: { headers: { 'x-retry-count': 1 } },
    });
    expect(retry.confirmations()).toBe(1);
    expect(retry.acknowledgements).toHaveLength(1);

    const dead = brokerFixture();
    await dead.service.consumeProviderCommands(() => Promise.resolve({ action: 'DEAD_LETTER', reason: 'malformed command' }));
    dead.deliver(message());
    await settle();
    expect(dead.publications[0]?.exchange).toBe(COMMANDS_DEAD_EXCHANGE);
    expect(dead.acknowledgements).toHaveLength(1);
  });

  it('NACKs and requeues the original when a retry copy cannot be confirmed', async () => {
    const fixture = brokerFixture({ failConfirmation: true });
    await fixture.service.consumeProviderCommands(() => Promise.resolve({ action: 'RETRY', reason: 'temporary provider error' }));

    fixture.deliver(message());
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(fixture.acknowledgements).toHaveLength(0);
    expect(fixture.negativeAcknowledgements).toHaveLength(1);
  });
});

interface Publication {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options?: Options.Publish;
}

function brokerFixture(options: { failConfirmation?: boolean } = {}) {
  let onMessage: ((message: ConsumeMessage | null) => void) | undefined;
  let confirmationCount = 0;
  const acknowledgements: ConsumeMessage[] = [];
  const negativeAcknowledgements: ConsumeMessage[] = [];
  const publications: Publication[] = [];
  const topology = {
    assertExchange: () => Promise.resolve({}),
    assertQueue: () => Promise.resolve({}),
    bindQueue: () => Promise.resolve({}),
  };
  const consumer = {
    ...topology,
    prefetch: () => Promise.resolve(),
    consume: (_queue: string, handler: (message: ConsumeMessage | null) => void) => {
      onMessage = handler;
      return Promise.resolve({ consumerTag: 'consumer-1' });
    },
    ack: (value: ConsumeMessage) => { acknowledgements.push(value); },
    nack: (value: ConsumeMessage) => { negativeAcknowledgements.push(value); },
    cancel: () => Promise.resolve({}),
    close: () => Promise.resolve(),
    on: () => undefined,
  } as unknown as Channel;
  const publisher = {
    ...topology,
    publish: (exchange: string, routingKey: string, content: Buffer, options?: Options.Publish) => {
      publications.push({ exchange, routingKey, content, options });
      return true;
    },
    waitForConfirms: () => {
      confirmationCount += 1;
      return options.failConfirmation ? Promise.reject(new Error('publisher confirm failed')) : Promise.resolve();
    },
    close: () => Promise.resolve(),
    on: () => undefined,
  } as unknown as ConfirmChannel;
  const connection = {
    createChannel: () => Promise.resolve(consumer),
    createConfirmChannel: () => Promise.resolve(publisher),
    close: () => Promise.resolve(),
    on: () => undefined,
  } as unknown as ChannelModel;
  const connect = (() => Promise.resolve(connection)) as AmqpConnect;
  const config = { get: (_key: string, fallback: unknown) => fallback } as unknown as ConfigService;
  const service = new RabbitMqService(config, connect);
  return {
    service,
    acknowledgements,
    negativeAcknowledgements,
    publications,
    confirmations: () => confirmationCount,
    deliver: (value: ConsumeMessage) => {
      if (!onMessage) throw new Error('consumer was not registered');
      onMessage(value);
    },
  };
}

function message(): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify({ id: 'outbox-1' })),
    fields: { routingKey: 'provider.capture.requested' },
    properties: { messageId: 'outbox-1', correlationId: 'attempt-1', headers: { 'x-retry-count': 0 } },
  } as unknown as ConsumeMessage;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
