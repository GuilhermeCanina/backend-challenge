import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQS_CLIENT } from './sqs.constants.js';

interface OutboxRow {
  id: unknown;
  aggregate_id: unknown;
  event_type: unknown;
  payload: unknown;
  attempts: unknown;
}

interface PublishOutcome {
  readonly state: 'published' | 'retry';
  readonly outboxId: string;
  readonly eventType: string;
  readonly attempt: number;
  readonly messageId?: string;
  readonly retryInSeconds?: number;
  readonly error?: string;
}

/**
 * Publishes committed integration events from PostgreSQL Outbox to the outbound FIFO queue.
 * A row lock is held until SQS confirms the send and published_at commits. If the process
 * crashes after SQS accepted the message but before PostgreSQL commits, the same stable
 * MessageDeduplicationId is sent again. This is intentionally at-least-once delivery.
 */
@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly queueName: string;
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly baseRetrySeconds: number;
  private readonly maxRetrySeconds: number;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private queueUrl: string | null = null;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly config: ConfigService,
    private readonly em: EntityManager
  ) {
    this.queueName = this.config.get<string>('SQS_OUTBOX_QUEUE_NAME', 'wager-events.fifo') ?? 'wager-events.fifo';
    this.enabled = (this.config.get<string>('OUTBOX_PUBLISHER_ENABLED', 'true') ?? 'true').trim().toLowerCase() !== 'false';
    this.pollIntervalMs = this.readIntegerConfig('OUTBOX_POLL_INTERVAL_MS', 1_000, 100, 60_000);
    this.baseRetrySeconds = this.readIntegerConfig('OUTBOX_BASE_RETRY_SECONDS', 1, 1, 300);
    this.maxRetrySeconds = this.readIntegerConfig('OUTBOX_MAX_RETRY_SECONDS', 300, this.baseRetrySeconds, 86_400);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('Outbox publisher is disabled by OUTBOX_PUBLISHER_ENABLED=false.');
      return;
    }
    this.stopping = false;
    this.loopPromise = this.publishLoop();
    this.logger.log(`Outbox publisher started for queue '${this.queueName}'.`);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.loopPromise) await this.loopPromise;
    this.logger.log('Outbox publisher stopped gracefully.');
  }

  private async publishLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const queueUrl = await this.getQueueUrl();
        const outcome = await this.publishOne(queueUrl);
        if (!outcome) {
          await this.delay(this.pollIntervalMs);
          continue;
        }
        if (outcome.state === 'published') {
          this.logger.log(JSON.stringify({
            event: 'outbox_event_published',
            outboxId: outcome.outboxId,
            eventType: outcome.eventType,
            attempt: outcome.attempt,
            sqsMessageId: outcome.messageId,
            queueName: this.queueName
          }));
        } else {
          this.logger.error(JSON.stringify({
            event: 'outbox_publish_failed',
            outboxId: outcome.outboxId,
            eventType: outcome.eventType,
            attempt: outcome.attempt,
            retryInSeconds: outcome.retryInSeconds,
            error: outcome.error
          }));
          // The failed row now has next_attempt_at in the future; avoid a hot loop.
          await this.delay(Math.min(this.pollIntervalMs, outcome.retryInSeconds! * 1_000));
        }
      } catch (error) {
        if (this.stopping) break;
        this.logger.error(`Outbox polling failed; the loop will retry. ${this.safeError(error)}`);
        await this.delay(this.pollIntervalMs);
      }
    }
  }

  private async publishOne(queueUrl: string): Promise<PublishOutcome | null> {
    return this.em.transactional(async (tx): Promise<PublishOutcome | null> => {
      const selected = await this.rows<OutboxRow>(tx.execute(
        `select candidate.id, candidate.aggregate_id, candidate.event_type, candidate.payload, candidate.attempts
         from outbox_messages candidate
         where candidate.published_at is null
           and (candidate.next_attempt_at is null or candidate.next_attempt_at <= now())
           and not exists (
             select 1
             from outbox_messages earlier
             where earlier.aggregate_id = candidate.aggregate_id
               and earlier.published_at is null
               and (earlier.occurred_at, earlier.id) < (candidate.occurred_at, candidate.id)
           )
         order by candidate.occurred_at asc, candidate.id asc
         limit 1
         for update of candidate skip locked`,
        [],
        'all'
      ));
      const row = selected[0];
      if (!row) return null;

      const outboxId = String(row.id).trim();
      const aggregateId = String(row.aggregate_id).trim();
      const eventType = String(row.event_type).trim();
      const currentAttempts = this.toNonNegativeInteger(row.attempts);
      const attempt = currentAttempts + 1;

      try {
        const payload = this.normalizePayload(row.payload);
        if (payload.eventType !== eventType || payload.aggregateId !== aggregateId) {
          throw new Error(`Outbox payload identity does not match row '${outboxId}'.`);
        }
        const eventId = typeof payload.eventId === 'string' && payload.eventId.length > 0
          ? payload.eventId
          : outboxId;

        const sent = await this.sqs.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(payload),
          MessageGroupId: aggregateId,
          // Stable across retries. FIFO deduplication is a short window, not an exactly-once guarantee.
          MessageDeduplicationId: this.toFifoSafeId(eventId, outboxId),
          MessageAttributes: {
            EventType: { DataType: 'String', StringValue: eventType.slice(0, 256) },
            EventId: { DataType: 'String', StringValue: eventId.slice(0, 256) },
            AggregateId: { DataType: 'String', StringValue: aggregateId.slice(0, 256) }
          }
        }));

        if (!sent.MessageId) {
          throw new Error('SQS did not return MessageId after SendMessage.');
        }

        const updated = await this.rows<{ id?: unknown }>(tx.execute(
          `update outbox_messages
           set published_at = now(), attempts = attempts + 1, next_attempt_at = null
           where id = ? and published_at is null
           returning id`,
          [outboxId],
          'all'
        ));
        if (updated.length !== 1) {
          throw new Error(`Outbox row '${outboxId}' could not be marked published after SQS confirmation.`);
        }

        return {
          state: 'published', outboxId, eventType, attempt,
          messageId: sent.MessageId
        };
      } catch (error) {
        const retryInSeconds = this.retryDelaySeconds(attempt);
        await tx.execute(
          `update outbox_messages
           set attempts = attempts + 1,
               next_attempt_at = now() + (? * interval '1 second')
           where id = ? and published_at is null`,
          [retryInSeconds, outboxId],
          'all'
        );
        return {
          state: 'retry', outboxId, eventType, attempt,
          retryInSeconds,
          error: this.safeError(error)
        };
      }
    }, { clear: true });
  }

  private async getQueueUrl(): Promise<string> {
    if (this.queueUrl) return this.queueUrl;
    const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
    if (!result.QueueUrl) throw new Error(`SQS did not return a QueueUrl for '${this.queueName}'.`);
    this.queueUrl = result.QueueUrl;
    return result.QueueUrl;
  }

  private normalizePayload(value: unknown): Record<string, unknown> {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Outbox payload must be a JSON object.');
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.eventType !== 'string' || typeof record.aggregateId !== 'string') {
      throw new Error('Outbox payload is missing eventType or aggregateId.');
    }
    return record;
  }

  private toFifoSafeId(value: string, fallback: string): string {
    // FIFO deduplication IDs allow alphanumeric characters, hyphens and underscores.
    const safe = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
    return safe.length > 0 ? safe : fallback.slice(0, 128);
  }

  private retryDelaySeconds(attempt: number): number {
    const exponent = Math.min(Math.max(attempt - 1, 0), 20);
    return Math.min(this.baseRetrySeconds * (2 ** exponent), this.maxRetrySeconds);
  }

  private toNonNegativeInteger(value: unknown): number {
    const parsed = Number(value ?? 0);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  private async rows<T>(promise: Promise<unknown>): Promise<T[]> {
    const result = await promise;
    if (Array.isArray(result)) return result as T[];
    if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
      return (result as { rows: T[] }).rows;
    }
    return [];
  }

  private readIntegerConfig(name: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<string>(name);
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  }

  private safeError(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return 'Unknown error';
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
