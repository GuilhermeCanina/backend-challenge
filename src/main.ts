import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? '3000');
  await app.listen(port, '0.0.0.0');

  Logger.log(`Wagering Processor listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
