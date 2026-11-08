import { WagerKind } from '../../../src/domain/wagering/wager-transaction.js';
import { describe, expect, test } from 'bun:test';
import {
  InvalidWagerMessageError,
  parseWagerTransactionRequest
} from '../../../src/application/messaging/wager-transaction-request-message.js';

function message(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: 'message-1',
    type: 'WagerTransactionRequested',
    version: 1,
    correlationId: 'correlation-1',
    occurredAt: '2026-11-08T19:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-1',
      idempotencyKey: 'provider-a:transaction-1',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' }
    },
    ...overrides
  });
}

describe('WagerTransactionRequested message parser', () => {
  test('parses a valid envelope and returns stable business payload hash', () => {
    const parsed = parseWagerTransactionRequest(message());
    expect(parsed.messageId).toBe('message-1');
    expect(parsed.idempotencyKey).toBe('provider-a:transaction-1');
    expect(parsed.input.kind).toBe(WagerKind.Bet);
    expect(parsed.input.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(parsed.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('does not include transport metadata in the Inbox payload hash', () => {
    const first = parseWagerTransactionRequest(message());
    const second = parseWagerTransactionRequest(JSON.stringify({
      ...JSON.parse(message()),
      messageId: 'message-2',
      correlationId: 'correlation-2',
      occurredAt: '2026-11-08T20:00:00.000Z'
    }));
    expect(first.payloadHash).toBe(second.payloadHash);
  });

  test('changes the Inbox hash when the business payload changes', () => {
    const original = JSON.parse(message()) as Record<string, any>;
    const changed = JSON.parse(message()) as Record<string, any>;
    changed.data.money.amount = '26.00';
    expect(parseWagerTransactionRequest(JSON.stringify(original)).payloadHash)
      .not.toBe(parseWagerTransactionRequest(JSON.stringify(changed)).payloadHash);
  });

  test('rejects malformed JSON', () => {
    expect(() => parseWagerTransactionRequest('{')).toThrow(InvalidWagerMessageError);
  });

  test('rejects unsupported message type', () => {
    expect(() => parseWagerTransactionRequest(message({ type: 'Unknown' }))).toThrow(InvalidWagerMessageError);
  });

  test('rejects unsupported version', () => {
    expect(() => parseWagerTransactionRequest(message({ version: 2 }))).toThrow(InvalidWagerMessageError);
  });

  test('rejects message IDs exceeding the Inbox schema length', () => {
    expect(() => parseWagerTransactionRequest(message({ messageId: 'x'.repeat(201) }))).toThrow(InvalidWagerMessageError);
  });

  test('rejects external OPENING requests', () => {
    const raw = JSON.parse(message()) as Record<string, any>;
    raw.data.kind = 'OPENING';
    expect(() => parseWagerTransactionRequest(JSON.stringify(raw))).toThrow(InvalidWagerMessageError);
  });

  test('rejects missing idempotency key', () => {
    const raw = JSON.parse(message()) as Record<string, any>;
    delete raw.data.idempotencyKey;
    expect(() => parseWagerTransactionRequest(JSON.stringify(raw))).toThrow(InvalidWagerMessageError);
  });
});
