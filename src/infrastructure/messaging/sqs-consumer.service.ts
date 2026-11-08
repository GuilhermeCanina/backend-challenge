import { createHash, randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message
} from '@aws-sdk/client-sqs';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  BadRequestException,
  UnprocessableEntityException,
  Inject
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/postgresql';
import { WageringService } from '../../modules/wagering/wagering.service.js';
import {
  InboxMessageIdentityConflictError,
  InvalidWagerMessageError,
  parseWagerTransactionRequest
} from '../../application/messaging/wager-transaction-request-message.js';
import { SQS_CLIENT } from './sqs.constants.js';

interface DbRow {
  payload_hash?: unknown;
  processed_at?: unknown;
}

interface MessageProcessingResult {
  readonly duplicate: boolean;
  readonly transactionId?: string;
  readonly status?: string;
}

@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);
  private readonly queueName: string;
  private readonly consumerName: string;
  private readonly deadLetterQueueName: string;
  private readonly enabled: boolean;
  private readonly waitTimeSeconds: number;
  private readonly visibilityTimeout: number;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private queueUrl: string | null = null;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly config: ConfigService,
    private readonly em: EntityManager,
    private readonly wagering: WageringService
  ) {
    this.queueName = this.config.get<string>('SQS_QUEUE_NAME', 'wager-transactions.fifo') ?? 'wager-transactions.fifo';
    this.consumerName = this.config.get<string>('SQS_CONSUMER_NAME', 'wager-transaction-consumer-v1') ?? 'wager-transaction-consumer-v1';
    this.deadLetterQueueName = this.config.get<string>('SQS_DLQ_NAME', 'wager-transactions-dlq.fifo') ?? 'wager-transactions-dlq.fifo';
    this.enabled = (this.config.get<string>('SQS_CONSUMER_ENABLED', 'true') ?? 'true').trim().toLowerCase() !== 'false';
    this.waitTimeSeconds = this.readIntegerConfig('SQS_WAIT_TIME_SECONDS', 10, 1, 20);
    this.visibilityTimeout = this.readIntegerConfig('SQS_VISIBILITY_TIMEOUT', 60, 1, 43200);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('SQS consumer is disabled by SQS_CONSUMER_ENABLED=false.');
      return;
    }
    this.stopping = false;
    this.loopPromise = this.pollLoop();
    this.logger.log(`SQS consumer started for queue '${this.queueName}'.`);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.loopPromise) await this.loopPromise;
    this.logger.log('SQS consumer stopped gracefully.');
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const queueUrl = await this.getQueueUrl();
        const result = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: this.waitTimeSeconds,
          VisibilityTimeout: this.visibilityTimeout,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId']
        }));

        // Finish messages already received before shutdown; no new batch is polled afterwards.
        for (const message of result.Messages ?? []) {
          await this.handleMessage(queueUrl, message);
        }
      } catch (error) {
        if (this.stopping) break;
        this.logger.error(`SQS polling failed; the loop will retry. ${this.safeError(error)}`);
        await this.delay(1_500);
      }
    }
  }

  private async handleMessage(queueUrl: string, message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    if (!receiptHandle || typeof message.Body !== 'string') {
      this.logger.error('Received an SQS message without a body or receipt handle; it will be retried.');
      return;
    }

    let parsed: ReturnType<typeof parseWagerTransactionRequest>;
    try {
      parsed = parseWagerTransactionRequest(message.Body);
    } catch (error) {
      await this.moveToDeadLetterQueue(queueUrl, message, 'INVALID_MESSAGE', error);
      return;
    }

    try {
      const outcome = await this.em.transactional(async (tx): Promise<MessageProcessingResult> => {
        const execute = (sql: string, params?: unknown[]) => tx.execute(sql, params, 'all');
        await execute(
          'select pg_advisory_xact_lock(hashtextextended(?, 0))',
          [`inbox:${this.consumerName}:${parsed.messageId}`]
        );

        const inboxRows = await this.rows<DbRow>(execute(
          `select payload_hash, processed_at from inbox_messages
           where consumer_name = ? and message_id = ? for update`,
          [this.consumerName, parsed.messageId]
        ));
        const existing = inboxRows[0];

        if (existing) {
          if (String(existing.payload_hash).trim() !== parsed.payloadHash) {
            throw new InboxMessageIdentityConflictError(parsed.messageId);
          }
          if (existing.processed_at) return { duplicate: true };
        } else {
          await execute(
            `insert into inbox_messages (id, consumer_name, message_id, payload_hash, received_at, processed_at)
             values (?, ?, ?, ?, now(), null)`,
            [randomUUID(), this.consumerName, parsed.messageId, parsed.payloadHash]
          );
        }

        const result = await this.wagering.processWagerInTransaction(
          tx,
          parsed.input,
          parsed.idempotencyKey,
          parsed.correlationId
        );

        const markedInboxRows = await this.rows<DbRow>(execute(
          `update inbox_messages set processed_at = now()
           where consumer_name = ? and message_id = ? and payload_hash = ? and processed_at is null
           returning id`,
          [this.consumerName, parsed.messageId, parsed.payloadHash]
        ));
        if (markedInboxRows.length !== 1) {
          throw new Error(`Inbox row '${parsed.messageId}' could not be marked processed inside its transaction.`);
        }

        return {
          duplicate: false,
          transactionId: result.transactionId,
          status: result.status
        };
      }, { clear: true });

      // ACK only after the PostgreSQL transaction has committed successfully.
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
      if (outcome.duplicate) {
        this.logger.log(JSON.stringify({ event: 'sqs_message_duplicate_acknowledged', consumerName: this.consumerName, messageId: parsed.messageId, sqsMessageId: message.MessageId, correlationId: parsed.correlationId, providerId: parsed.input.providerId, walletId: parsed.input.walletId }));
      } else {
        this.logger.log(JSON.stringify({
          event: 'sqs_message_processed',
          consumerName: this.consumerName,
          messageId: parsed.messageId,
          sqsMessageId: message.MessageId,
          correlationId: parsed.correlationId,
          providerId: parsed.input.providerId,
          walletId: parsed.input.walletId,
          transactionId: outcome.transactionId,
          status: outcome.status
        }));
      }
    } catch (error) {
      const receiveCount = message.Attributes?.ApproximateReceiveCount ?? 'unknown';
      if (this.isPermanent(error)) {
        this.logger.error(JSON.stringify({
          event: 'sqs_message_permanent_failure',
          consumerName: this.consumerName,
          messageId: parsed.messageId,
          sqsMessageId: message.MessageId,
          correlationId: parsed.correlationId,
          providerId: parsed.input.providerId,
          walletId: parsed.input.walletId,
          approximateReceiveCount: receiveCount,
          error: this.safeError(error),
          action: 'move_to_dlq_then_ack_source'
        }));
        await this.moveToDeadLetterQueue(queueUrl, message, this.errorCode(error), error);
      } else {
        this.logger.error(JSON.stringify({
          event: 'sqs_message_transient_failure',
          consumerName: this.consumerName,
          messageId: parsed.messageId,
          sqsMessageId: message.MessageId,
          correlationId: parsed.correlationId,
          providerId: parsed.input.providerId,
          walletId: parsed.input.walletId,
          approximateReceiveCount: receiveCount,
          error: this.safeError(error),
          action: 'leave_unacknowledged_for_retry'
        }));
      }
      // Transient failures are not ACKed: after VisibilityTimeout SQS redelivers.
      // The queue RedrivePolicy sends exhausted retries to the DLQ.
    }
  }

  private async moveToDeadLetterQueue(sourceQueueUrl: string, message: Message, code: string, error: unknown): Promise<void> {
    if (!message.ReceiptHandle || typeof message.Body !== 'string') return;
    try {
      const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.deadLetterQueueName }));
      if (!result.QueueUrl) throw new Error(`SQS did not return a QueueUrl for DLQ '${this.deadLetterQueueName}'.`);
      const deduplicationId = createHash('sha256')
        .update(`${code}:${message.MessageId ?? 'unknown'}:${message.Body}`)
        .digest('hex')
        .slice(0, 64);

      await this.sqs.send(new SendMessageCommand({
        QueueUrl: result.QueueUrl,
        MessageBody: message.Body,
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'quarantine',
        MessageDeduplicationId: deduplicationId,
        MessageAttributes: {
          FailureCode: { DataType: 'String', StringValue: code.slice(0, 256) },
          FailureReason: { DataType: 'String', StringValue: this.safeError(error).slice(0, 900) },
          SourceQueue: { DataType: 'String', StringValue: this.queueName.slice(0, 256) },
          SourceMessageId: { DataType: 'String', StringValue: (message.MessageId ?? 'unknown').slice(0, 256) }
        }
      }));

      // The source is deleted only after SQS confirms the DLQ send.
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: sourceQueueUrl, ReceiptHandle: message.ReceiptHandle }));
      this.logger.warn(JSON.stringify({
        event: 'sqs_message_moved_to_dlq',
        consumerName: this.consumerName,
        sqsMessageId: message.MessageId,
        deadLetterQueue: this.deadLetterQueueName,
        failureCode: code
      }));
    } catch (dlqError) {
      // Do not ACK the source if the DLQ send or source deletion failed.
      this.logger.error(`Unable to move permanent SQS message to DLQ; source message remains unacknowledged. ${this.safeError(dlqError)}`);
    }
  }

  private errorCode(error: unknown): string {
    if (error instanceof InboxMessageIdentityConflictError) return 'INBOX_MESSAGE_IDENTITY_CONFLICT';
    if (error instanceof InvalidWagerMessageError) return 'INVALID_MESSAGE';
    return 'PERMANENT_BUSINESS_ERROR';
  }

  private async getQueueUrl(): Promise<string> {
    if (this.queueUrl) return this.queueUrl;
    const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
    if (!result.QueueUrl) throw new Error(`SQS did not return a QueueUrl for '${this.queueName}'.`);
    this.queueUrl = result.QueueUrl;
    return result.QueueUrl;
  }

  private async rows<T>(promise: Promise<unknown>): Promise<T[]> {
    const result = await promise;
    if (Array.isArray(result)) return result as T[];
    if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
      return (result as { rows: T[] }).rows;
    }
    return [];
  }

  private isPermanent(error: unknown): boolean {
    if (error instanceof InvalidWagerMessageError || error instanceof InboxMessageIdentityConflictError) return true;
    if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException || error instanceof UnprocessableEntityException) return true;
    return false;
  }

  private safeError(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return 'Unknown error';
  }

  private readIntegerConfig(name: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<string>(name);
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
