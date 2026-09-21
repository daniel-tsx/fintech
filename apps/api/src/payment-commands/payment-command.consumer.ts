import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DomainError } from '../common/domain-error';
import { PermanentProviderError, RetryableProviderError, UnknownProviderOutcomeError } from '../payment-provider/payment-provider.types';
import {
  BrokerDelivery,
  BrokerDisposition,
  COMMAND_BROKER,
  CommandBroker,
  MalformedProviderCommandError,
  PROVIDER_COMMAND_EVENT_TYPES,
  ProviderCommandEnvelope,
  ProviderCommandEventType,
} from '../rabbitmq/rabbitmq.types';
import { PaymentCommandHandlerService } from './payment-command-handler.service';

const MAX_DELIVERY_ATTEMPTS = 8;

@Injectable()
export class PaymentCommandConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentCommandConsumer.name);

  constructor(
    @Inject(COMMAND_BROKER) private readonly broker: CommandBroker,
    private readonly handler: PaymentCommandHandlerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.broker.consumeProviderCommands((delivery) => this.handle(delivery));
  }

  async handle(delivery: BrokerDelivery): Promise<BrokerDisposition> {
    try {
      const message = this.parse(delivery);
      await this.handler.execute(message);
      return { action: 'ACK' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown provider command error';
      if (error instanceof MalformedProviderCommandError || error instanceof PermanentProviderError || error instanceof DomainError) {
        this.logger.warn({ messageId: delivery.messageId, error: reason }, 'Provider command sent to dead-letter queue');
        return { action: 'DEAD_LETTER', reason };
      }
      const retryable = error instanceof RetryableProviderError || error instanceof UnknownProviderOutcomeError || error instanceof Error;
      if (retryable && delivery.retryCount + 1 < MAX_DELIVERY_ATTEMPTS) {
        this.logger.warn({ messageId: delivery.messageId, retryCount: delivery.retryCount, error: reason }, 'Provider command scheduled for broker retry');
        return { action: 'RETRY', reason };
      }
      this.logger.error({ messageId: delivery.messageId, retryCount: delivery.retryCount, error: reason }, 'Provider command exhausted retries');
      return { action: 'DEAD_LETTER', reason };
    }
  }

  private parse(delivery: BrokerDelivery): ProviderCommandEnvelope {
    if (delivery.parseError) throw new MalformedProviderCommandError(`Provider command is not valid JSON: ${delivery.parseError}`);
    if (!delivery.body || typeof delivery.body !== 'object' || Array.isArray(delivery.body)) throw new MalformedProviderCommandError('Provider command body must be an object');
    const candidate = delivery.body as Record<string, unknown>;
    const id = this.requiredString(candidate.id, 'id');
    const eventType = this.eventType(candidate.eventType);
    if (delivery.messageId && delivery.messageId !== id) throw new MalformedProviderCommandError('RabbitMQ messageId does not match the outbox event id');
    if (delivery.routingKey !== eventType) throw new MalformedProviderCommandError('RabbitMQ routing key does not match the provider command type');
    if (!candidate.payload || typeof candidate.payload !== 'object' || Array.isArray(candidate.payload)) throw new MalformedProviderCommandError('Provider command payload must be an object');
    return {
      id,
      eventType,
      aggregateId: this.requiredString(candidate.aggregateId, 'aggregateId'),
      payload: candidate.payload as Record<string, unknown>,
      createdAt: this.requiredString(candidate.createdAt, 'createdAt'),
      correlationId: this.requiredString(candidate.correlationId, 'correlationId'),
    };
  }

  private eventType(value: unknown): ProviderCommandEventType {
    if (typeof value === 'string' && PROVIDER_COMMAND_EVENT_TYPES.includes(value as ProviderCommandEventType)) return value as ProviderCommandEventType;
    throw new MalformedProviderCommandError(`Unsupported provider command type ${String(value)}`);
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) throw new MalformedProviderCommandError(`Provider command field ${field} must be a non-empty string`);
    return value;
  }
}
