import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/domain-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger)); app.enableShutdownHooks(); app.setGlobalPrefix('api/v1'); app.use(helmet());
  app.enableCors({ origin: ['http://localhost:3000'], credentials: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new DomainExceptionFilter());
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('fintech-lab API').setDescription('Local payment-platform simulation. API acceptance is not final financial outcome.').setVersion('1.0').addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }).build());
  SwaggerModule.setup('docs', app, document);
  await app.listen(Number(process.env.PORT ?? 4000));
}

void bootstrap();
