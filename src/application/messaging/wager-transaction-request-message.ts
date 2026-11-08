import { randomUUID } from 'node:crypto';
import { hashCanonicalPayload, type JsonValue } from '../idempotency/canonical-payload-hash.js';
import type { MoneyProps } from '../../domain/shared/money.js';
import type { WagerKind } from '../../domain/wagering/wager-transaction.js';
import type { SubmitWagerInput } from '../../modules/wagering/wagering.service.js';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

export class InvalidWagerMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerMessageError';
  }
}

export class InboxMessageIdentityConflictError extends Error {
  constructor(messageId: string) {
    super(`Inbox messageId '${messageId}' was previously received with a different business payload.`);
    this.name = 'InboxMessageIdentityConflictError';
  }
}

export interface ParsedWagerTransactionRequest {
  readonly messageId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly input: SubmitWagerInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string, maxLength: number): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new InvalidWagerMessageError(`Message field '${field}' must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

/** Parse and validate the versioned business envelope from an SQS message body. */
export function parseWagerTransactionRequest(body: string): ParsedWagerTransactionRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new InvalidWagerMessageError('Message body is not valid JSON.');
  }

  if (!isRecord(parsed)) throw new InvalidWagerMessageError('Message body must be a JSON object.');
  if (parsed.type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidWagerMessageError(`Unsupported message type '${String(parsed.type)}'.`);
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new InvalidWagerMessageError(`Unsupported message version '${String(parsed.version)}'.`);
  }

  const messageId = requiredString(parsed, 'messageId', 200);
  const correlationId = typeof parsed.correlationId === 'string' && parsed.correlationId.trim()
    ? parsed.correlationId.trim()
    : randomUUID();
  if (parsed.occurredAt !== undefined && (typeof parsed.occurredAt !== 'string' || Number.isNaN(Date.parse(parsed.occurredAt)))) {
    throw new InvalidWagerMessageError("Message field 'occurredAt' must be an ISO-compatible date string when provided.");
  }
  const data = parsed.data;
  if (!isRecord(data)) throw new InvalidWagerMessageError("Message field 'data' must be an object.");

  const providerId = requiredString(data, 'providerId', 120);
  const externalTransactionId = requiredString(data, 'externalTransactionId', 180);
  const playerId = requiredString(data, 'playerId', 64);
  const walletId = requiredString(data, 'walletId', 64);
  const roundId = requiredString(data, 'roundId', 180);
  const gameId = requiredString(data, 'gameId', 180);
  const idempotencyKey = requiredString(data, 'idempotencyKey', 240);
  const kind = requiredString(data, 'kind', 20);

  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind) || kind === 'OPENING') {
    throw new InvalidWagerMessageError(`Unsupported external wager kind '${kind}'.`);
  }
  if (!isRecord(data.money) || typeof data.money.amount !== 'string' || typeof data.money.currency !== 'string') {
    throw new InvalidWagerMessageError("Message field 'data.money' must contain string amount and currency fields.");
  }

  const referenceExternalTransactionId = data.referenceExternalTransactionId;
  if (referenceExternalTransactionId !== undefined && referenceExternalTransactionId !== null && typeof referenceExternalTransactionId !== 'string') {
    throw new InvalidWagerMessageError("Message field 'data.referenceExternalTransactionId' must be a string when provided.");
  }

  // The Inbox hash excludes transport metadata (messageId, correlationId, occurredAt)
  // and includes the complete versioned business payload.
  let payloadHash: string;
  try {
    payloadHash = hashCanonicalPayload({ type: parsed.type, version: parsed.version ?? 1, data } as unknown as JsonValue);
  } catch (error) {
    throw new InvalidWagerMessageError(error instanceof Error ? error.message : 'Unable to hash message payload.');
  }

  return {
    messageId,
    correlationId,
    idempotencyKey,
    payloadHash,
    input: {
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind: kind as WagerKind,
      money: data.money as unknown as MoneyProps,
      ...(typeof referenceExternalTransactionId === 'string'
        ? { referenceExternalTransactionId: referenceExternalTransactionId.trim() }
        : {})
    }
  };
}
