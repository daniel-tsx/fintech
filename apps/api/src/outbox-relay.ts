import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { OutboxRelayAppModule } from './outbox-relay-app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(OutboxRelayAppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}

void bootstrap();
