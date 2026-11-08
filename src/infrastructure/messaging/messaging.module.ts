import { Module } from '@nestjs/common';
import { SqsClientModule } from './sqs-client.module.js';
import { SqsConsumerService } from './sqs-consumer.service.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';
import { PendingReferenceWorkerService } from './pending-reference-worker.service.js';
import { WageringModule } from '../../modules/wagering/wagering.module.js';

@Module({
  imports: [SqsClientModule, WageringModule],
  providers: [SqsConsumerService, OutboxPublisherService, PendingReferenceWorkerService]
})
export class MessagingModule {}
