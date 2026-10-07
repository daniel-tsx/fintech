import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { once } from 'node:events';
import {
  BrokerDelivery,
  BrokerDisposition,
  COMMANDS_DEAD_EXCHANGE,
  COMMANDS_EXCHANGE,
  COMMANDS_RETRY_EXCHANGE,
  CommandBroker,
  PAYMENT_COMMANDS_DEAD_QUEUE,
  PAYMENT_COMMANDS_QUEUE,
  PAYMENT_COMMANDS_RETRY_QUEUE,
  PROVIDER_COMMAND_EVENT_TYPES,
  ProviderCommandEnvelope,
} from './rabbitmq.types';

export const AMQP_CONNECT = Symbol('AMQP_CONNECT');
export type AmqpConnect = typeof amqp.connect;

@Injectable()
export class RabbitMqService implements CommandBroker, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqService.name);
  private readonly url: string;
  private readonly prefetch: number;
  private connection?: ChannelModel;
  private connectionPromise?: Promise<ChannelModel>;
  private publisher?: ConfirmChannel;
  private consumer?: Channel;
  private consumerTag?: string;
  private handler?: (delivery: BrokerDelivery) => Promise<BrokerDisposition>;
  private closing = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    config: ConfigService,
    @Inject(AMQP_CONNECT) private readonly connect: AmqpConnect,
  ) {
    this.url = config.get<string>('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672');
    this.prefetch = Number(config.get('RABBITMQ_PREFETCH', 10));
  }

  async publishProviderCommand(message: ProviderCommandEnvelope): Promise<void> {
    const channel = await this.publisherChannel();
    const accepted = channel.publish(
      COMMANDS_EXCHANGE,
      message.eventType,
      Buffer.from(JSON.stringify(message)),
      this.properties(message, 0),
    );
    if (!accepted) await once(channel, 'drain');
    await channel.waitForConfirms();
  }

  async consumeProviderCommands(handler: (delivery: BrokerDelivery) => Promise<BrokerDisposition>): Promise<void> {
    this.handler = handler;
    await this.startConsumer().catch(() => undefined);
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.consumer && this.consumerTag) await this.consumer.cancel(this.consumerTag).catch(() => undefined);
    await this.consumer?.close().catch(() => undefined);
    await this.publisher?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async startConsumer(): Promise<void> {
    if (!this.handler || this.closing || this.consumer) return;
    try {
      const connection = await this.getConnection();
      const channel = await connection.createChannel();
      await this.assertTopology(channel);
      await channel.prefetch(this.prefetch);
      channel.on('close', () => {
        if (this.consumer === channel) this.consumer = undefined;
        if (this.handler && !this.closing) this.scheduleConsumerReconnect();
      });
      this.consumer = channel;
      const reply = await channel.consume(PAYMENT_COMMANDS_QUEUE, (message) => {
        if (message) void this.processDelivery(channel, message);
      }, { noAck: false });
      this.consumerTag = reply.consumerTag;
    } catch (error) {
      this.logger.error({ error: this.errorMessage(error) }, 'RabbitMQ consumer could not start');
      this.scheduleConsumerReconnect();
      throw error;
    }
  }

  private async processDelivery(channel: Channel, message: ConsumeMessage): Promise<void> {
    const delivery = this.delivery(message);
    try {
      const disposition = await this.handler!(delivery);
      if (disposition.action === 'ACK') {
        channel.ack(message);
        return;
      }
      const exchange = disposition.action === 'RETRY' ? COMMANDS_RETRY_EXCHANGE : COMMANDS_DEAD_EXCHANGE;
      const retryCount = disposition.action === 'RETRY' ? delivery.retryCount + 1 : delivery.retryCount;
      await this.republish(exchange, message, retryCount, disposition.reason);
      channel.ack(message);
    } catch (error) {
      this.logger.error({ messageId: this.propertyString(message.properties.messageId), error: this.errorMessage(error) }, 'RabbitMQ delivery handling failed before ACK');
      setTimeout(() => {
        try { channel.nack(message, false, true); } catch { /* connection close requeues unacknowledged deliveries */ }
      }, 1_000);
    }
  }

  private async republish(exchange: string, message: ConsumeMessage, retryCount: number, reason: string): Promise<void> {
    const channel = await this.publisherChannel();
    const options: Options.Publish = {
      ...message.properties,
      persistent: true,
      headers: { ...message.properties.headers, 'x-retry-count': retryCount, 'x-failure-reason': reason },
    };
    const accepted = channel.publish(exchange, message.fields.routingKey, message.content, options);
    if (!accepted) await once(channel, 'drain');
    await channel.waitForConfirms();
  }

  private delivery(message: ConsumeMessage): BrokerDelivery {
    let body: unknown;
    let parseError: string | undefined;
    try {
      body = JSON.parse(message.content.toString('utf8')) as unknown;
    } catch (error) {
      parseError = this.errorMessage(error);
    }
    return {
      body,
      messageId: this.propertyString(message.properties.messageId),
      correlationId: this.propertyString(message.properties.correlationId),
      routingKey: message.fields.routingKey,
      retryCount: Number(message.properties.headers?.['x-retry-count'] ?? 0),
      parseError,
    };
  }

  private async publisherChannel(): Promise<ConfirmChannel> {
    if (this.publisher) return this.publisher;
    const connection = await this.getConnection();
    const channel = await connection.createConfirmChannel();
    channel.on('close', () => {
      if (this.publisher === channel) this.publisher = undefined;
    });
    await this.assertTopology(channel);
    this.publisher = channel;
    return channel;
  }

  private async getConnection(): Promise<ChannelModel> {
    if (this.connection) return this.connection;
    if (!this.connectionPromise) {
      this.connectionPromise = this.connect(this.url).then((connection) => {
        this.connection = connection;
        connection.on('error', (error) => this.logger.warn({ error: this.errorMessage(error) }, 'RabbitMQ connection error'));
        connection.on('close', () => {
          this.connection = undefined;
          this.connectionPromise = undefined;
          this.publisher = undefined;
          this.consumer = undefined;
          this.consumerTag = undefined;
          if (this.handler && !this.closing) this.scheduleConsumerReconnect();
        });
        return connection;
      }).catch((error) => {
        this.connectionPromise = undefined;
        throw error;
      });
    }
    return this.connectionPromise;
  }

  private scheduleConsumerReconnect(): void {
    if (this.reconnectTimer || this.closing) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.startConsumer().catch(() => undefined);
    }, 1_000);
  }

  private async assertTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(COMMANDS_EXCHANGE, 'direct', { durable: true });
    await channel.assertExchange(COMMANDS_RETRY_EXCHANGE, 'direct', { durable: true });
    await channel.assertExchange(COMMANDS_DEAD_EXCHANGE, 'direct', { durable: true });
    await channel.assertQueue(PAYMENT_COMMANDS_QUEUE, { durable: true });
    await channel.assertQueue(PAYMENT_COMMANDS_RETRY_QUEUE, {
      durable: true,
      arguments: { 'x-message-ttl': 5_000, 'x-dead-letter-exchange': COMMANDS_EXCHANGE },
    });
    await channel.assertQueue(PAYMENT_COMMANDS_DEAD_QUEUE, { durable: true });
    for (const routingKey of PROVIDER_COMMAND_EVENT_TYPES) {
      await channel.bindQueue(PAYMENT_COMMANDS_QUEUE, COMMANDS_EXCHANGE, routingKey);
      await channel.bindQueue(PAYMENT_COMMANDS_RETRY_QUEUE, COMMANDS_RETRY_EXCHANGE, routingKey);
      await channel.bindQueue(PAYMENT_COMMANDS_DEAD_QUEUE, COMMANDS_DEAD_EXCHANGE, routingKey);
    }
  }

  private properties(message: ProviderCommandEnvelope, retryCount: number): Options.Publish {
    return {
      persistent: true,
      contentType: 'application/json',
      messageId: message.id,
      correlationId: message.correlationId,
      type: message.eventType,
      timestamp: Math.floor(Date.parse(message.createdAt) / 1_000),
      headers: { eventType: message.eventType, createdAt: message.createdAt, 'x-retry-count': retryCount },
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown RabbitMQ error';
  }

  private propertyString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }
}
