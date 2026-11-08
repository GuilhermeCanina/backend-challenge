import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs.constants.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly entityManager: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    private readonly config: ConfigService
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ready'; dependencies: { postgres: 'ok'; sqs: 'ok' } }> {
    try {
      await this.entityManager.getConnection().execute('select 1');
      const inboundQueueName = this.config.get<string>('SQS_QUEUE_NAME', 'wager-transactions.fifo') ?? 'wager-transactions.fifo';
      const outboxQueueName = this.config.get<string>('SQS_OUTBOX_QUEUE_NAME', 'wager-events.fifo') ?? 'wager-events.fifo';
      await Promise.all([
        this.sqsClient.send(new GetQueueUrlCommand({ QueueName: inboundQueueName })),
        this.sqsClient.send(new GetQueueUrlCommand({ QueueName: outboxQueueName }))
      ]);
      return { status: 'ready', dependencies: { postgres: 'ok', sqs: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready' });
    }
  }
}
