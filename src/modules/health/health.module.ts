import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { SqsClientModule } from '../../infrastructure/messaging/sqs-client.module.js';

@Module({
  imports: [SqsClientModule],
  controllers: [HealthController]
})
export class HealthModule {}
