import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';
import { Money, type MoneyProps } from '../../domain/shared/money.js';
import { Wallet, type WalletState } from '../../domain/wallet/wallet.js';
import { WageringProcessor } from '../../domain/wagering/wagering-processor.js';
import {
  WagerKind,
  WagerStatus,
  WagerTransaction,
  type WagerTransactionState
} from '../../domain/wagering/wager-transaction.js';
import { hashCanonicalPayload, type JsonValue } from '../../application/idempotency/canonical-payload-hash.js';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged
} from '../../application/events/integration-events.js';

interface DbRow { [key: string]: unknown }

export interface CreateWalletInput {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
}

export interface SubmitWagerInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | null;
}

export interface ProcessWagerResponse {
  readonly transactionId: string;
  readonly status: WagerStatus;
  readonly balance: MoneyProps | null;
  readonly idempotentReplay: boolean;
  readonly failureCode?: string;
}

export interface PendingReferencePolicy {
  readonly maxAttempts: number;
  readonly ttlSeconds: number;
  readonly baseRetrySeconds: number;
  readonly maxRetrySeconds: number;
}

export type PendingReferenceWorkResult =
  | { readonly outcome: 'idle' }
  | { readonly outcome: 'retry'; readonly transactionId: string; readonly attempts: number; readonly retryInSeconds: number }
  | { readonly outcome: 'processed' | 'rejected'; readonly transactionId: string; readonly status: WagerStatus; readonly attempts: number; readonly failureCode?: string };

@Injectable()
export class WageringService {
  private readonly processor = new WageringProcessor();

  constructor(private readonly em: EntityManager) {}

  async createWallet(input: CreateWalletInput): Promise<DbRow> {
    this.assertUuid(input?.playerId, 'playerId');
    const initialBalance = this.parseMoney(input?.initialBalance);
    if (!initialBalance.isPositive()) throw new BadRequestException('initialBalance must be greater than zero.');
    const walletId = randomUUID();
    const transactionId = randomUUID();
    const ledgerId = randomUUID();
    const now = new Date();
    const openingId = `opening:${walletId}`;
    const openingPayloadHash = hashCanonicalPayload({ playerId: input.playerId, walletId, money: initialBalance.toJSON() } as unknown as JsonValue);
    const correlationId = randomUUID();

    try {
      return await this.em.transactional(async (tx) => {
        const conn = { execute: (sql: string, params?: unknown[]) => tx.execute(sql, params, 'all') };
        await conn.execute(
          `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
           values (?, ?, ?, ?, 1, ?, ?)`,
          [walletId, input.playerId, initialBalance.currency, initialBalance.toString(), now, now]
        );
        await conn.execute(
          `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, status, response_balance, created_at, processed_at)
           values (?, '__internal__', ?, ?, ?, ?, ?, '__opening__', '__opening__', 'OPENING', ?, ?, 'PROCESSED', ?, ?, ?)`,
          [transactionId, openingId, openingId, openingPayloadHash, walletId, input.playerId,
            initialBalance.toString(), initialBalance.currency, initialBalance.toString(), now, now]
        );
        await conn.execute(
          `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
           values (?, ?, ?, 'CREDIT', ?, ?, '0.00', ?, 1, ?)`,
          [ledgerId, walletId, transactionId, initialBalance.toString(), initialBalance.currency, initialBalance.toString(), now]
        );
        const openingProcessed = WagerTransactionProcessed.from({
          aggregateId: walletId,
          correlationId,
          occurredAt: now,
          data: {
            transactionId,
            providerId: '__internal__',
            externalTransactionId: openingId,
            walletId,
            kind: 'OPENING',
            status: 'PROCESSED',
            balance: initialBalance.toJSON()
          }
        });
        await this.insertOutbox(conn, openingProcessed.toJSON(), openingProcessed.eventType, walletId, now);
        const event = WalletBalanceChanged.from({
          aggregateId: walletId,
          correlationId,
          occurredAt: now,
          causationId: transactionId,
          data: {
            walletId, transactionId, direction: LedgerDirection.Credit,
            money: initialBalance.toJSON(),
            balanceBefore: Money.zero(initialBalance.currency).toJSON(),
            balanceAfter: initialBalance.toJSON(), walletVersion: 1
          }
        });
        await this.insertOutbox(conn, event.toJSON(), event.eventType, walletId, now);
        return {
          id: walletId,
          playerId: input.playerId,
          balance: initialBalance.toJSON(),
          version: 1,
          currency: initialBalance.currency,
          createdAt: now.toISOString()
        };
      }, { clear: true });
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException('A wallet already exists for this player and currency.');
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      throw this.toInfrastructureError(error);
    }
  }

  async processWager(input: SubmitWagerInput, idempotencyKey: string, correlationId: string = randomUUID()): Promise<ProcessWagerResponse> {
    try {
      return await this.em.transactional(
        (tx) => this.processWagerInTransaction(tx, input, idempotencyKey, correlationId),
        { clear: true }
      );
    } catch (error) {
      // Keep HTTP commit-time failures mapped to the same retryable response as before the extraction.
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException || error instanceof ServiceUnavailableException) throw error;
      if (this.isUniqueViolation(error)) throw new ConflictException('A conflicting wallet or transaction already exists.');
      throw this.toInfrastructureError(error);
    }
  }

  /**
   * Executes the exact same financial use case inside a caller-owned SQL transaction.
   * The SQS consumer uses this to commit Inbox + wallet + wager + ledger + Outbox atomically.
   */
  async processWagerInTransaction(
    tx: EntityManager,
    input: SubmitWagerInput,
    idempotencyKey: string,
    correlationId: string = randomUUID()
  ): Promise<ProcessWagerResponse> {
    this.validateWagerInput(input);
    if (!idempotencyKey || idempotencyKey.trim().length === 0 || idempotencyKey.length > 240) {
      throw new BadRequestException('Idempotency-Key header is required and must contain at most 240 characters.');
    }
    const money = this.parseMoney(input.money);
    if (!money.isPositive()) throw new BadRequestException('money.amount must be greater than zero.');
    const referenceExternalId = input.referenceExternalTransactionId?.trim() || null;
    const businessPayload = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: referenceExternalId
    };
    const payloadHash = hashCanonicalPayload(businessPayload as unknown as JsonValue);
    const transactionId = randomUUID();
    const ledgerId = randomUUID();
    const now = new Date();

    const conn = { execute: (sql: string, params?: unknown[]) => tx.execute(sql, params, 'all') };
    try {
        // Transaction-scoped, key-specific advisory locks serialize competing idempotency claims.
        await conn.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`idem:${idempotencyKey}`]);
        await conn.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`external:${input.providerId}:${input.externalTransactionId}`]);

        const existingRows = await this.rows<DbRow>(conn.execute(
          'select * from wager_transactions where idempotency_key = ? limit 1', [idempotencyKey]
        ));
        if (existingRows[0]) {
          const existing = existingRows[0];
          if (String(existing.payload_hash).trim() !== payloadHash) {
            throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'The Idempotency-Key was already used with a different business payload.' });
          }
          return this.responseFromRow(existing, true);
        }

        const externalRows = await this.rows<DbRow>(conn.execute(
          'select * from wager_transactions where provider_id = ? and external_transaction_id = ? limit 1',
          [input.providerId, input.externalTransactionId]
        ));
        if (externalRows[0]) {
          const existing = externalRows[0];
          if (String(existing.payload_hash).trim() !== payloadHash) {
            throw new ConflictException({ code: 'EXTERNAL_TRANSACTION_CONFLICT', message: 'Provider transaction id already exists with a different payload.' });
          }
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'The external transaction already exists under a different Idempotency-Key.' });
        }

        const walletRows = await this.rows<DbRow>(conn.execute(
          'select * from wallets where id = ? and player_id = ? for update', [input.walletId, input.playerId]
        ));
        const walletRow = walletRows[0];
        if (!walletRow) throw new NotFoundException('Wallet not found for the supplied playerId.');
        const wallet = this.rehydrateWallet(walletRow);
        if (wallet.currency !== money.currency) {
          throw new ConflictException({ code: 'CURRENCY_MISMATCH', message: 'Wallet and wager currencies differ.' });
        }

        let reference: WagerTransaction | null = null;
        if (referenceExternalId) {
          const referenceRows = await this.rows<DbRow>(conn.execute(
            `select * from wager_transactions where provider_id = ? and external_transaction_id = ? limit 1`,
            [input.providerId, referenceExternalId]
          ));
          if (referenceRows[0]) reference = this.rehydrateWager(referenceRows[0]);
        }

        const transaction = WagerTransaction.create({
          id: transactionId,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey,
          payloadHash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          amount: money,
          referenceExternalTransactionId: referenceExternalId,
          createdAt: now
        });

        let alreadyReversed = false;
        if (reference && (input.kind === WagerKind.Refund || input.kind === WagerKind.Rollback)) {
          const reversalRows = await this.rows<DbRow>(conn.execute(
            'select id from wager_transactions where reference_transaction_id = ? and kind = ? limit 1',
            [reference.id, input.kind]
          ));
          alreadyReversed = reversalRows.length > 0;
        }

        const result = this.processor.process(transaction, wallet, {
          ledgerEntryId: ledgerId,
          at: now,
          reference,
          alreadyReversedBySameKind: alreadyReversed
        });
        const state = transaction.toState();

        await conn.execute(
          `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
            status, failure_code, response_balance, created_at, processed_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [state.id, state.providerId, state.externalTransactionId, state.idempotencyKey, state.payloadHash,
            state.walletId, state.playerId, state.roundId, state.gameId, state.kind, state.amount.toString(), state.amount.currency,
            state.referenceExternalTransactionId, state.referenceTransactionId, state.status, state.failureCode,
            state.responseBalance?.toString() ?? null, state.createdAt, state.processedAt]
        );

        if ('ledgerEntry' in result && result.ledgerEntry) {
          const entry = result.ledgerEntry;
          const priorVersion = wallet.version - 1;
          const updateRows = await this.rows<DbRow>(conn.execute(
            `update wallets set balance = ?, version = ?, updated_at = ? where id = ? and version = ? returning id`,
            [entry.balanceAfter.toString(), entry.walletVersion, now, wallet.id, priorVersion]
          ));
          if (updateRows.length !== 1) throw new ServiceUnavailableException('Wallet version changed during processing; retry the request.');
          await conn.execute(
            `insert into wallet_ledger_entries
             (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money.toString(), entry.money.currency,
              entry.balanceBefore.toString(), entry.balanceAfter.toString(), entry.walletVersion, entry.createdAt]
          );
        }

        const eventData = {
          transactionId: state.id,
          providerId: state.providerId,
          externalTransactionId: state.externalTransactionId,
          walletId: state.walletId,
          kind: state.kind,
          status: state.status,
          balance: state.responseBalance?.toJSON() ?? null,
          ...(state.failureCode ? { failureCode: state.failureCode } : {})
        };
        if (result.outcome === 'PROCESSED') {
          const event = WagerTransactionProcessed.from({ aggregateId: wallet.id, correlationId, occurredAt: now, data: eventData });
          await this.insertOutbox(conn, event.toJSON(), event.eventType, wallet.id, now);
        } else if (result.outcome === 'REJECTED') {
          const event = WagerTransactionRejected.from({ aggregateId: wallet.id, correlationId, occurredAt: now, data: eventData });
          await this.insertOutbox(conn, event.toJSON(), event.eventType, wallet.id, now);
        } else {
          const event = WagerTransactionPendingReference.from({ aggregateId: wallet.id, correlationId, occurredAt: now, data: eventData });
          await this.insertOutbox(conn, event.toJSON(), event.eventType, wallet.id, now);
        }

        if ('ledgerEntry' in result && result.ledgerEntry) {
          const entry = result.ledgerEntry;
          const event = WalletBalanceChanged.from({
            aggregateId: wallet.id,
            correlationId,
            occurredAt: now,
            causationId: transaction.id,
            data: {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction: entry.direction,
              money: entry.money.toJSON(),
              balanceBefore: entry.balanceBefore.toJSON(),
              balanceAfter: entry.balanceAfter.toJSON(),
              walletVersion: entry.walletVersion
            }
          });
          await this.insertOutbox(conn, event.toJSON(), event.eventType, wallet.id, now);
        }

        return {
          transactionId: state.id,
          status: state.status,
          balance: state.responseBalance?.toJSON() ?? null,
          idempotentReplay: false,
          ...(state.failureCode ? { failureCode: state.failureCode } : {})
        };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException || error instanceof ServiceUnavailableException) throw error;
      if (this.isUniqueViolation(error)) throw new ConflictException('A conflicting wallet or transaction already exists.');
      throw this.toInfrastructureError(error);
    }
  }

  /**
   * Processes at most one due PENDING_REFERENCE transaction.
   * Selection, wallet mutation, ledger, transaction state and Outbox remain in one SQL commit.
   */
  async processNextPendingReference(policy: PendingReferencePolicy): Promise<PendingReferenceWorkResult> {
    return this.em.transactional(async (tx): Promise<PendingReferenceWorkResult> => {
      const conn = { execute: (sql: string, params?: unknown[]) => tx.execute(sql, params, 'all') };
      const selected = await this.rows<DbRow>(conn.execute(
        `select * from wager_transactions
         where status = 'PENDING_REFERENCE'
           and (
             reference_next_attempt_at is null
             or reference_next_attempt_at <= now()
             or created_at <= now() - (? * interval '1 second')
           )
         order by created_at asc, id asc
         limit 1
         for update skip locked`,
        [policy.ttlSeconds]
      ));
      const pendingRow = selected[0];
      if (!pendingRow) return { outcome: 'idle' };

      const now = new Date();
      const transactionId = String(pendingRow.id);
      const attempt = this.toNonNegativeInteger(pendingRow.reference_attempts) + 1;
      const createdAt = new Date(String(pendingRow.created_at));
      const expired = now.getTime() >= createdAt.getTime() + policy.ttlSeconds * 1_000;
      if (expired) {
        return this.rejectPendingReference(conn, pendingRow, now, attempt, 'REFERENCE_TTL_EXPIRED');
      }

      const referenceExternalId = String(pendingRow.reference_external_transaction_id ?? '');
      const referenceRows = await this.rows<DbRow>(conn.execute(
        `select * from wager_transactions
         where provider_id = ? and external_transaction_id = ?
         limit 1`,
        [String(pendingRow.provider_id), referenceExternalId]
      ));
      const referenceRow = referenceRows[0];
      const referenceStatus = referenceRow ? String(referenceRow.status) : null;
      const referenceIsStillPending = referenceStatus === WagerStatus.Pending
        || referenceStatus === WagerStatus.PendingReference;
      const referenceIsUnavailable = !referenceRow || referenceIsStillPending;

      if (referenceIsUnavailable) {
        if (attempt >= policy.maxAttempts) {
          return this.rejectPendingReference(
            conn,
            pendingRow,
            now,
            attempt,
            referenceRow ? 'REFERENCE_NOT_READY' : 'REFERENCE_NOT_FOUND'
          );
        }

        const exponent = Math.min(Math.max(attempt - 1, 0), 20);
        const retryInSeconds = Math.min(policy.baseRetrySeconds * (2 ** exponent), policy.maxRetrySeconds);
        await conn.execute(
          `update wager_transactions
           set reference_attempts = ?,
               reference_next_attempt_at = now() + (? * interval '1 second')
           where id = ? and status = 'PENDING_REFERENCE'`,
          [attempt, retryInSeconds, transactionId]
        );
        return { outcome: 'retry', transactionId, attempts: attempt, retryInSeconds };
      }

      const walletRows = await this.rows<DbRow>(conn.execute(
        'select * from wallets where id = ? and player_id = ? for update',
        [String(pendingRow.wallet_id), String(pendingRow.player_id)]
      ));
      const walletRow = walletRows[0];
      if (!walletRow) throw new Error(`Wallet '${String(pendingRow.wallet_id)}' for pending wager '${transactionId}' no longer exists.`);

      const pending = this.rehydrateWager(pendingRow);
      const reference = this.rehydrateWager(referenceRow!);
      const wallet = this.rehydrateWallet(walletRow);
      let alreadyReversed = false;
      if (pending.kind === WagerKind.Refund || pending.kind === WagerKind.Rollback) {
        const reversalRows = await this.rows<DbRow>(conn.execute(
          'select id from wager_transactions where reference_transaction_id = ? and kind = ? limit 1',
          [reference.id, pending.kind]
        ));
        alreadyReversed = reversalRows.length > 0;
      }

      const correlationId = randomUUID();
      const result = this.processor.process(pending, wallet, {
        ledgerEntryId: randomUUID(),
        at: now,
        reference,
        alreadyReversedBySameKind: alreadyReversed
      });
      const state = pending.toState();
      await conn.execute(
        `update wager_transactions
         set reference_transaction_id = ?, status = ?, failure_code = ?, response_balance = ?,
             processed_at = ?, reference_attempts = ?, reference_next_attempt_at = null
         where id = ? and status = 'PENDING_REFERENCE'`,
        [state.referenceTransactionId, state.status, state.failureCode,
          state.responseBalance?.toString() ?? null, state.processedAt, attempt, transactionId]
      );

      if ('ledgerEntry' in result && result.ledgerEntry) {
        const entry = result.ledgerEntry;
        const priorVersion = wallet.version - 1;
        const updateRows = await this.rows<DbRow>(conn.execute(
          `update wallets set balance = ?, version = ?, updated_at = ?
           where id = ? and version = ? returning id`,
          [entry.balanceAfter.toString(), entry.walletVersion, now, wallet.id, priorVersion]
        ));
        if (updateRows.length !== 1) throw new Error(`Wallet '${wallet.id}' version changed while resolving pending reference.`);
        await conn.execute(
          `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money.toString(), entry.money.currency,
            entry.balanceBefore.toString(), entry.balanceAfter.toString(), entry.walletVersion, entry.createdAt]
        );
      }

      const eventData = {
        transactionId: state.id,
        providerId: state.providerId,
        externalTransactionId: state.externalTransactionId,
        walletId: state.walletId,
        kind: state.kind,
        status: state.status,
        balance: state.responseBalance?.toJSON() ?? null,
        ...(state.failureCode ? { failureCode: state.failureCode } : {})
      };
      if (result.outcome === 'PROCESSED') {
        const event = WagerTransactionProcessed.from({ aggregateId: wallet.id, correlationId, occurredAt: now, data: eventData });
        await this.insertOutbox(conn, event.toJSON(), event.eventType, wallet.id, now);
      } else {
        const event = WagerTransactionRejected.from({ aggregateId: wallet.id, correlationId, occurredAt: now, data: eventData });
        await this.insertOutbox(conn, event.toJSON(), event.eventType, wallet.id, now);
      }

      if ('ledgerEntry' in result && result.ledgerEntry) {
        const entry = result.ledgerEntry;
        const event = WalletBalanceChanged.from({
          aggregateId: wallet.id,
          correlationId,
          occurredAt: now,
          causationId: pending.id,
          data: {
            walletId: wallet.id,
            transactionId: pending.id,
            direction: entry.direction,
            money: entry.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: entry.walletVersion
          }
        });
        await this.insertOutbox(conn, event.toJSON(), event.eventType, wallet.id, now);
      }

      return {
        outcome: result.outcome === 'PROCESSED' ? 'processed' : 'rejected',
        transactionId,
        status: state.status,
        attempts: attempt,
        ...(state.failureCode ? { failureCode: state.failureCode } : {})
      };
    }, { clear: true });
  }

  private async rejectPendingReference(
    conn: { execute: (sql: string, params?: unknown[]) => Promise<unknown> },
    pendingRow: DbRow,
    now: Date,
    attempt: number,
    failureCode: 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_READY' | 'REFERENCE_TTL_EXPIRED'
  ): Promise<PendingReferenceWorkResult> {
    const transactionId = String(pendingRow.id);
    const walletRows = await this.rows<DbRow>(conn.execute(
      'select * from wallets where id = ? and player_id = ? for update',
      [String(pendingRow.wallet_id), String(pendingRow.player_id)]
    ));
    const walletRow = walletRows[0];
    if (!walletRow) throw new Error(`Wallet '${String(pendingRow.wallet_id)}' for pending wager '${transactionId}' no longer exists.`);

    const pending = this.rehydrateWager(pendingRow);
    const wallet = this.rehydrateWallet(walletRow);
    pending.reject(failureCode, wallet.balance, now);
    const state = pending.toState();
    await conn.execute(
      `update wager_transactions
       set status = 'REJECTED', failure_code = ?, response_balance = ?, processed_at = ?,
           reference_attempts = ?, reference_next_attempt_at = null
       where id = ? and status = 'PENDING_REFERENCE'`,
      [failureCode, wallet.balance.toString(), now, attempt, transactionId]
    );

    const event = WagerTransactionRejected.from({
      aggregateId: wallet.id,
      correlationId: randomUUID(),
      occurredAt: now,
      data: {
        transactionId: state.id,
        providerId: state.providerId,
        externalTransactionId: state.externalTransactionId,
        walletId: state.walletId,
        kind: state.kind,
        status: state.status,
        balance: state.responseBalance?.toJSON() ?? null,
        failureCode
      }
    });
    await this.insertOutbox(conn, event.toJSON(), event.eventType, wallet.id, now);
    return { outcome: 'rejected', transactionId, status: WagerStatus.Rejected, attempts: attempt, failureCode };
  }

  async getWallet(walletId: string): Promise<DbRow> {
    this.assertUuid(walletId, 'walletId');
    const rows = await this.safeQuery<DbRow>('select id, player_id, currency, balance, version, created_at, updated_at from wallets where id = ?', [walletId]);
    const row = rows[0];
    if (!row) throw new NotFoundException('Wallet not found.');
    return {
      id: row.id,
      playerId: row.player_id,
      balance: { amount: this.decimal(row.balance), currency: String(row.currency).trim() },
      version: row.version,
      createdAt: this.iso(row.created_at),
      updatedAt: this.iso(row.updated_at)
    };
  }

  async getLedger(walletId: string, cursor?: string, limit = 50): Promise<DbRow> {
    this.assertUuid(walletId, 'walletId');
    const safeLimit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 50));
    let beforeVersion: number | null = null;
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const parsed = Number(decoded);
        if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('invalid cursor');
        beforeVersion = parsed;
      } catch {
        throw new BadRequestException('Invalid ledger cursor.');
      }
    }
    const rows = beforeVersion === null
      ? await this.safeQuery<DbRow>(
          'select * from wallet_ledger_entries where wallet_id = ? order by wallet_version desc limit ?',
          [walletId, safeLimit + 1]
        )
      : await this.safeQuery<DbRow>(
          'select * from wallet_ledger_entries where wallet_id = ? and wallet_version < ? order by wallet_version desc limit ?',
          [walletId, beforeVersion, safeLimit + 1]
        );
    const hasMore = rows.length > safeLimit;
    const page = rows.slice(0, safeLimit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id, walletId: row.wallet_id, transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: this.decimal(row.amount), currency: String(row.currency).trim() },
        balanceBefore: { amount: this.decimal(row.balance_before), currency: String(row.currency).trim() },
        balanceAfter: { amount: this.decimal(row.balance_after), currency: String(row.currency).trim() },
        walletVersion: row.wallet_version, createdAt: this.iso(row.created_at)
      })),
      nextCursor: hasMore && last ? Buffer.from(String(last.wallet_version), 'utf8').toString('base64url') : null
    };
  }

  async getTransaction(transactionId: string): Promise<DbRow> {
    this.assertUuid(transactionId, 'transactionId');
    const rows = await this.safeQuery<DbRow>('select * from wager_transactions where id = ?', [transactionId]);
    if (!rows[0]) throw new NotFoundException('Transaction not found.');
    return this.publicTransaction(rows[0]);
  }

  async getProviderTransaction(providerId: string, externalTransactionId: string): Promise<DbRow> {
    const rows = await this.safeQuery<DbRow>(
      'select * from wager_transactions where provider_id = ? and external_transaction_id = ?',
      [providerId, externalTransactionId]
    );
    if (!rows[0]) throw new NotFoundException('Provider transaction not found.');
    return this.publicTransaction(rows[0]);
  }

  async reconcileWallet(walletId: string): Promise<DbRow> {
    this.assertUuid(walletId, 'walletId');
    const rows = await this.safeQuery<DbRow>(
      `select w.id, w.currency, w.balance as stored_balance,
        coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2) as calculated_balance,
        count(l.id)::int as checked_entries
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
       where w.id = ? group by w.id`, [walletId]
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Wallet not found.');
    const stored = this.decimal(row.stored_balance);
    const calculated = this.decimal(row.calculated_balance);
    const diff = new Decimal(calculated).minus(new Decimal(stored)).toFixed(2);
    const consistent = stored === calculated;
    if (!consistent) console.error(JSON.stringify({ level: 'error', event: 'wallet_reconciliation_mismatch', walletId, currency: String(row.currency).trim(), storedBalance: stored, calculatedBalance: calculated }));
    return {
      walletId,
      storedBalance: { amount: stored, currency: String(row.currency).trim() },
      calculatedBalance: { amount: calculated, currency: String(row.currency).trim() },
      difference: { amount: diff, currency: String(row.currency).trim() },
      consistent,
      checkedEntries: Number(row.checked_entries)
    };
  }

  private async safeQuery<T extends DbRow>(sql: string, params: unknown[]): Promise<T[]> {
    try { return await this.rows<T>(this.em.execute(sql, params, 'all')); }
    catch (error) { throw this.toInfrastructureError(error); }
  }

  private async rows<T>(promise: Promise<unknown>): Promise<T[]> {
    const result = await promise;
    if (Array.isArray(result)) return result as T[];
    if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
    return [];
  }

  private rehydrateWallet(row: DbRow): Wallet {
    const currency = String(row.currency).trim();
    const state: WalletState = {
      id: String(row.id), playerId: String(row.player_id), currency,
      balance: Money.from({ amount: this.decimal(row.balance), currency }),
      version: Number(row.version), createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at))
    };
    return Wallet.rehydrate(state);
  }

  private rehydrateWager(row: DbRow): WagerTransaction {
    const currency = String(row.currency).trim();
    const status = String(row.status) as WagerStatus;
    const responseBalance = row.response_balance === null || row.response_balance === undefined
      ? null : Money.from({ amount: this.decimal(row.response_balance), currency });
    const state: WagerTransactionState = {
      id: String(row.id), providerId: String(row.provider_id), externalTransactionId: String(row.external_transaction_id),
      idempotencyKey: String(row.idempotency_key), payloadHash: String(row.payload_hash).trim(),
      walletId: String(row.wallet_id), playerId: String(row.player_id), roundId: String(row.round_id), gameId: String(row.game_id),
      kind: String(row.kind) as WagerKind,
      amount: Money.from({ amount: this.decimal(row.amount), currency }),
      referenceExternalTransactionId: row.reference_external_transaction_id ? String(row.reference_external_transaction_id) : null,
      status,
      failureCode: row.failure_code ? String(row.failure_code) : null,
      referenceTransactionId: row.reference_transaction_id ? String(row.reference_transaction_id) : null,
      responseBalance,
      createdAt: new Date(String(row.created_at)),
      processedAt: row.processed_at ? new Date(String(row.processed_at)) : null
    };
    return WagerTransaction.rehydrate(state);
  }

  private responseFromRow(row: DbRow, idempotentReplay: boolean): ProcessWagerResponse {
    return {
      transactionId: String(row.id),
      status: String(row.status) as WagerStatus,
      balance: row.response_balance === null || row.response_balance === undefined
        ? null
        : { amount: this.decimal(row.response_balance), currency: String(row.currency).trim() },
      idempotentReplay,
      ...(row.failure_code ? { failureCode: String(row.failure_code) } : {})
    };
  }

  private publicTransaction(row: DbRow): DbRow {
    return {
      transactionId: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      status: row.status,
      money: { amount: this.decimal(row.amount), currency: String(row.currency).trim() },
      referenceExternalTransactionId: row.reference_external_transaction_id ?? null,
      referenceTransactionId: row.reference_transaction_id ?? null,
      referenceAttempts: this.toNonNegativeInteger(row.reference_attempts),
      nextReferenceAttemptAt: row.reference_next_attempt_at ? this.iso(row.reference_next_attempt_at) : null,
      failureCode: row.failure_code ?? null,
      balance: row.response_balance === null || row.response_balance === undefined
        ? null : { amount: this.decimal(row.response_balance), currency: String(row.currency).trim() },
      createdAt: this.iso(row.created_at),
      processedAt: row.processed_at ? this.iso(row.processed_at) : null
    };
  }

  private async insertOutbox(conn: { execute: (sql: string, params?: unknown[]) => Promise<unknown> }, event: Record<string, unknown>, eventType: string, aggregateId: string, occurredAt: Date): Promise<void> {
    await conn.execute(
      'insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts) values (?, ?, ?, ?::jsonb, ?, 0)',
      [randomUUID(), aggregateId, eventType, JSON.stringify(event), occurredAt]
    );
  }

  private validateWagerInput(input: SubmitWagerInput): void {
    if (!input || typeof input !== 'object') throw new BadRequestException('Request body is required.');
    for (const [field, value] of Object.entries({
      providerId: input.providerId, externalTransactionId: input.externalTransactionId,
      playerId: input.playerId, walletId: input.walletId, roundId: input.roundId, gameId: input.gameId
    })) {
      if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
    }
    if (input.providerId.length > 120 || input.externalTransactionId.length > 180 || input.roundId.length > 180 || input.gameId.length > 180) {
      throw new BadRequestException('One or more identifiers exceed their maximum length.');
    }
    this.assertUuid(input.playerId, 'playerId');
    this.assertUuid(input.walletId, 'walletId');
    if (!Object.values(WagerKind).includes(input.kind)) throw new BadRequestException('Unsupported wager kind.');
    if (input.referenceExternalTransactionId != null && typeof input.referenceExternalTransactionId !== 'string') {
      throw new BadRequestException('referenceExternalTransactionId must be a string.');
    }
    if (input.referenceExternalTransactionId && input.referenceExternalTransactionId.length > 180) {
      throw new BadRequestException('referenceExternalTransactionId is too long.');
    }
    const hasReference = Boolean(input.referenceExternalTransactionId?.trim());
    if ((input.kind === WagerKind.Refund || input.kind === WagerKind.Rollback) && !hasReference) {
      throw new BadRequestException(`${input.kind} requires referenceExternalTransactionId.`);
    }
    if (hasReference && input.kind !== WagerKind.Win && input.kind !== WagerKind.Refund && input.kind !== WagerKind.Rollback) {
      throw new BadRequestException(`${input.kind} cannot contain a reference transaction.`);
    }
    if (hasReference && input.referenceExternalTransactionId?.trim() === input.externalTransactionId) {
      throw new BadRequestException('A transaction cannot reference itself.');
    }
  }

  private parseMoney(value: MoneyProps): Money {
    try { return Money.from(value); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid money value.'); }
  }

  private assertUuid(value: string, field: string): void {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new BadRequestException(`${field} must be a valid UUID.`);
    }
  }

  private toNonNegativeInteger(value: unknown): number {
    const parsed = Number(value ?? 0);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  private decimal(value: unknown): string {
    const text = String(value);
    const [whole, fraction = ''] = text.split('.');
    return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  }

  private iso(value: unknown): string {
    return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505');
  }

  private toInfrastructureError(error: unknown): Error {
    if (error instanceof Error && error.name === 'NotFoundException') return error;
    return new ServiceUnavailableException({
      code: 'PERSISTENCE_UNAVAILABLE',
      message: 'A persistence operation failed. The request can be retried with the same Idempotency-Key.'
    });
  }
}
