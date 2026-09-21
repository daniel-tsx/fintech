import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { PaymentCommandWorkerAppModule } from './payment-command-worker-app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(PaymentCommandWorkerAppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}

void bootstrap();
