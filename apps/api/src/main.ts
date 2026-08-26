import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const port = Number(process.env.API_PORT ?? 3001);

  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });
  // No global ValidationPipe: every body is validated by ZodValidationPipe against the
  // schemas in @aitp/shared, so class-validator would be a second, redundant source of truth.
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('AI Testing Platform API')
    .setDescription('Run orchestration, live execution events and the AI Command Box.')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(port);
  new Logger('bootstrap').log(`API listening on http://localhost:${port}/api (docs at /api/docs)`);
}

void bootstrap();
