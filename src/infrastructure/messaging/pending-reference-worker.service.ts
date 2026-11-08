import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WageringService } from '../../modules/wagering/wagering.service.js';

/** Polls PostgreSQL for due PENDING_REFERENCE wagers; SKIP LOCKED supports multiple instances. */
@Injectable()
export class PendingReferenceWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorkerService.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly ttlSeconds: number;
  private readonly baseRetrySeconds: number;
  private readonly maxRetrySeconds: number;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly wagering: WageringService
  ) {
    this.enabled = this.readBooleanConfig('PENDING_REFERENCE_WORKER_ENABLED', true);
    this.pollIntervalMs = this.readIntegerConfig('PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000, 100, 60_000);
    this.maxAttempts = this.readIntegerConfig('PENDING_REFERENCE_MAX_ATTEMPTS', 10, 1, 1_000);
    this.ttlSeconds = this.readIntegerConfig('PENDING_REFERENCE_TTL_SECONDS', 3_600, 1, 604_800);
    this.baseRetrySeconds = this.readIntegerConfig('PENDING_REFERENCE_BASE_RETRY_SECONDS', 2, 1, 3_600);
    this.maxRetrySeconds = this.readIntegerConfig('PENDING_REFERENCE_MAX_RETRY_SECONDS', 300, this.baseRetrySeconds, 86_400);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('Pending-reference worker is disabled by PENDING_REFERENCE_WORKER_ENABLED=false.');
      return;
    }
    this.stopping = false;
    this.loopPromise = this.runLoop();
    this.logger.log(
      `Pending-reference worker started (poll=${this.pollIntervalMs}ms, maxAttempts=${this.maxAttempts}, ttl=${this.ttlSeconds}s).`
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.loopPromise) await this.loopPromise;
    this.logger.log('Pending-reference worker stopped gracefully.');
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.wagering.processNextPendingReference({
          maxAttempts: this.maxAttempts,
          ttlSeconds: this.ttlSeconds,
          baseRetrySeconds: this.baseRetrySeconds,
          maxRetrySeconds: this.maxRetrySeconds
        });

        if (result.outcome === 'idle') {
          await this.delay(this.pollIntervalMs);
        } else if (result.outcome === 'retry') {
          this.logger.log(JSON.stringify({
            event: 'pending_reference_retry_scheduled',
            transactionId: result.transactionId,
            attempts: result.attempts,
            retryInSeconds: result.retryInSeconds
          }));
          // Avoid an immediate hot loop; the persisted next-attempt timestamp is authoritative.
          await this.delay(Math.min(this.pollIntervalMs, result.retryInSeconds * 1_000));
        } else {
          this.logger.log(JSON.stringify({
            event: result.outcome === 'processed' ? 'pending_reference_resolved' : 'pending_reference_rejected',
            transactionId: result.transactionId,
            status: result.status,
            attempts: result.attempts,
            ...(result.failureCode ? { failureCode: result.failureCode } : {})
          }));
        }
      } catch (error) {
        if (this.stopping) break;
        this.logger.error(`Pending-reference worker iteration failed; it will retry. ${this.safeError(error)}`);
        await this.delay(this.pollIntervalMs);
      }
    }
  }

  private readBooleanConfig(key: string, fallback: boolean): boolean {
    const value = this.config.get<string>(key);
    if (value === undefined || value === null || value.trim() === '') return fallback;
    return value.trim().toLowerCase() !== 'false';
  }

  private readIntegerConfig(key: string, fallback: number, min: number, max: number): number {
    const value = this.config.get<string>(key);
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      this.logger.warn(`Invalid ${key}='${value}'; using default ${fallback}.`);
      return fallback;
    }
    return parsed;
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}
