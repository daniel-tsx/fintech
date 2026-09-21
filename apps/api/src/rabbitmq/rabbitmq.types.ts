export const COMMAND_BROKER = Symbol('COMMAND_BROKER');

export const COMMANDS_EXCHANGE = 'fintech.commands';
export const COMMANDS_RETRY_EXCHANGE = 'fintech.commands.retry';
export const COMMANDS_DEAD_EXCHANGE = 'fintech.commands.dead';
export const PAYMENT_COMMANDS_QUEUE = 'payment-provider.commands';
export const PAYMENT_COMMANDS_RETRY_QUEUE = 'payment-provider.commands.retry';
export const PAYMENT_COMMANDS_DEAD_QUEUE = 'payment-provider.commands.dead';

export const PROVIDER_COMMAND_EVENT_TYPES = [
  'provider.authorization.requested',
  'provider.capture.requested',
  'provider.refund.requested',
  'provider.void.requested',
] as const;

export type ProviderCommandEventType = (typeof PROVIDER_COMMAND_EVENT_TYPES)[number];

export interface ProviderCommandEnvelope {
  id: string;
  eventType: ProviderCommandEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  correlationId: string;
}

export interface BrokerDelivery {
  body: unknown;
  messageId?: string;
  correlationId?: string;
  routingKey: string;
  retryCount: number;
  parseError?: string;
}

export type BrokerDisposition =
  | { action: 'ACK' }
  | { action: 'RETRY'; reason: string }
  | { action: 'DEAD_LETTER'; reason: string };

export interface CommandBroker {
  publishProviderCommand(message: ProviderCommandEnvelope): Promise<void>;
  consumeProviderCommands(handler: (delivery: BrokerDelivery) => Promise<BrokerDisposition>): Promise<void>;
}

export class MalformedProviderCommandError extends Error {}
