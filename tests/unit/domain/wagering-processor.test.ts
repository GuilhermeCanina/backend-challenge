import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/shared/money.js';
import { Wallet } from '../../../src/domain/wallet/wallet.js';
import {
  WagerFailureCode,
  WagerKind,
  WagerStatus,
  WagerTransaction,
  WagerTransactionStateError
} from '../../../src/domain/wagering/wager-transaction.js';
import { WageringProcessor } from '../../../src/domain/wagering/wagering-processor.js';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry.js';

const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });
const processor = new WageringProcessor();
const now = new Date('2026-11-06T12:00:00.000Z');
let transactionSequence = 0;

function makeTransaction(
  kind: WagerKind,
  options: {
    id?: string;
    externalId?: string;
    amount?: string;
    referenceExternalId?: string | null;
    playerId?: string;
    walletId?: string;
    providerId?: string;
    roundId?: string;
  } = {}
): WagerTransaction {
  transactionSequence += 1;
  return WagerTransaction.create({
    id: options.id ?? `transaction-${transactionSequence}`,
    providerId: options.providerId ?? 'provider-1',
    externalTransactionId: options.externalId ?? `external-${transactionSequence}`,
    idempotencyKey: `idempotency-${transactionSequence}`,
    payloadHash: 'a'.repeat(64),
    walletId: options.walletId ?? 'wallet-1',
    playerId: options.playerId ?? 'player-1',
    roundId: options.roundId ?? 'round-1',
    gameId: 'game-1',
    kind,
    amount: money(options.amount ?? '10.00'),
    referenceExternalTransactionId: options.referenceExternalId ?? null,
    createdAt: now
  });
}

function makeWallet(balance = '100.00'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: money(balance),
    at: now
  });
}

describe('WagerTransaction', () => {
  test('creates new provider transactions in PENDING state', () => {
    const transaction = makeTransaction(WagerKind.Bet);
    expect(transaction.status).toBe(WagerStatus.Pending);
    expect(transaction.isTerminal).toBe(false);
  });

  test('requires a reference for REFUND and ROLLBACK', () => {
    expect(() => makeTransaction(WagerKind.Refund)).toThrow();
    expect(() => makeTransaction(WagerKind.Rollback)).toThrow();
  });

  test('rejects malformed payload hashes', () => {
    expect(() => WagerTransaction.create({
      id: 'tx-invalid', providerId: 'provider-1', externalTransactionId: 'ext-invalid',
      idempotencyKey: 'idem-invalid', payloadHash: 'not-a-hash', walletId: 'wallet-1',
      playerId: 'player-1', roundId: 'round-1', gameId: 'game-1', kind: WagerKind.Bet,
      amount: money('1.00')
    })).toThrow();
  });

  test('PENDING_REFERENCE can be resolved later and terminal states cannot transition', () => {
    const transaction = makeTransaction(WagerKind.Rollback, { referenceExternalId: 'bet-1' });
    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerStatus.PendingReference);
    transaction.markProcessed(money('110.00'), now, 'reference-id');
    expect(transaction.status).toBe(WagerStatus.Processed);
    expect(() => transaction.reject(WagerFailureCode.InvalidReference, money('110.00')))
      .toThrow(WagerTransactionStateError);
  });
});

describe('WageringProcessor', () => {
  test('BET debits the wallet and creates a DEBIT ledger entry', () => {
    const wallet = makeWallet();
    const transaction = makeTransaction(WagerKind.Bet, { amount: '25.00' });
    const result = processor.process(transaction, wallet, { ledgerEntryId: 'ledger-1', at: now });

    expect(result.outcome).toBe('PROCESSED');
    if (result.outcome !== 'PROCESSED') throw new Error('Expected processed result');
    expect(result.balance.toString()).toBe('75.00');
    expect(result.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(result.ledgerEntry?.balanceBefore.toString()).toBe('100.00');
    expect(result.ledgerEntry?.balanceAfter.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
  });

  test('BET with insufficient funds is rejected without changing the wallet', () => {
    const wallet = makeWallet('20.00');
    const transaction = makeTransaction(WagerKind.Bet, { amount: '20.01' });
    const result = processor.process(transaction, wallet, { ledgerEntryId: 'ledger-2', at: now });

    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') throw new Error('Expected rejected result');
    expect(result.failureCode).toBe(WagerFailureCode.InsufficientFunds);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(transaction.status).toBe(WagerStatus.Rejected);
  });

  test('WIN credits the wallet and may reference a processed BET with a different amount', () => {
    const wallet = makeWallet('20.00');
    const bet = makeTransaction(WagerKind.Bet, { externalId: 'bet-42', amount: '5.00' });
    bet.markProcessed(money('15.00'), now);
    const win = makeTransaction(WagerKind.Win, { amount: '25.00', referenceExternalId: 'bet-42' });

    const result = processor.process(win, wallet, { ledgerEntryId: 'ledger-3', reference: bet, at: now });
    expect(result.outcome).toBe('PROCESSED');
    expect(wallet.balance.toString()).toBe('45.00');
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test('LOSS is processed without a ledger entry or balance version change', () => {
    const wallet = makeWallet();
    const transaction = makeTransaction(WagerKind.Loss);
    const result = processor.process(transaction, wallet, { ledgerEntryId: 'unused', at: now });

    expect(result.outcome).toBe('PROCESSED');
    if (result.outcome !== 'PROCESSED') throw new Error('Expected processed result');
    expect(result.ledgerEntry).toBeNull();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('REFUND credits the exact amount of a processed BET', () => {
    const wallet = makeWallet('75.00');
    const bet = makeTransaction(WagerKind.Bet, { externalId: 'bet-refund', amount: '25.00' });
    bet.markProcessed(money('75.00'), now);
    const refund = makeTransaction(WagerKind.Refund, { amount: '25.00', referenceExternalId: 'bet-refund' });

    const result = processor.process(refund, wallet, { ledgerEntryId: 'ledger-refund', reference: bet, at: now });
    expect(result.outcome).toBe('PROCESSED');
    expect(wallet.balance.toString()).toBe('100.00');
    if (result.outcome !== 'PROCESSED') throw new Error('Expected processed result');
    expect(result.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK of BET reverses the debit with a credit', () => {
    const wallet = makeWallet('75.00');
    const bet = makeTransaction(WagerKind.Bet, { externalId: 'bet-rollback', amount: '25.00' });
    bet.markProcessed(money('75.00'), now);
    const rollback = makeTransaction(WagerKind.Rollback, { amount: '25.00', referenceExternalId: 'bet-rollback' });

    const result = processor.process(rollback, wallet, { ledgerEntryId: 'ledger-rollback', reference: bet, at: now });
    expect(result.outcome).toBe('PROCESSED');
    expect(wallet.balance.toString()).toBe('100.00');
    if (result.outcome !== 'PROCESSED') throw new Error('Expected processed result');
    expect(result.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK of WIN reverses the credit with a debit', () => {
    const wallet = makeWallet('125.00');
    const win = makeTransaction(WagerKind.Win, { externalId: 'win-rollback', amount: '25.00' });
    win.markProcessed(money('125.00'), now);
    const rollback = makeTransaction(WagerKind.Rollback, { amount: '25.00', referenceExternalId: 'win-rollback' });

    const result = processor.process(rollback, wallet, { ledgerEntryId: 'ledger-rollback-win', reference: win, at: now });
    expect(result.outcome).toBe('PROCESSED');
    expect(wallet.balance.toString()).toBe('100.00');
    if (result.outcome !== 'PROCESSED') throw new Error('Expected processed result');
    expect(result.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK is rejected with a distinct code when reversing a credit would make balance negative', () => {
    const wallet = makeWallet('10.00');
    const win = makeTransaction(WagerKind.Win, { externalId: 'win-too-late', amount: '25.00' });
    win.markProcessed(money('35.00'), now);
    const rollback = makeTransaction(WagerKind.Rollback, { amount: '25.00', referenceExternalId: 'win-too-late' });

    const result = processor.process(rollback, wallet, { ledgerEntryId: 'ledger-rollback-negative', reference: win, at: now });
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') throw new Error('Expected rejected result');
    expect(result.failureCode).toBe(WagerFailureCode.ReversalWouldCauseNegativeBalance);
    expect(wallet.balance.toString()).toBe('10.00');
  });

  test('missing reference becomes PENDING_REFERENCE', () => {
    const wallet = makeWallet();
    const refund = makeTransaction(WagerKind.Refund, { referenceExternalId: 'not-arrived-yet' });
    const result = processor.process(refund, wallet, { ledgerEntryId: 'unused', at: now });
    expect(result.outcome).toBe('PENDING_REFERENCE');
    expect(refund.status).toBe(WagerStatus.PendingReference);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('rejects a reference from another player or round', () => {
    const wallet = makeWallet();
    const bet = makeTransaction(WagerKind.Bet, {
      externalId: 'bet-wrong-owner', amount: '10.00', playerId: 'another-player'
    });
    bet.markProcessed(money('90.00'), now);
    const refund = makeTransaction(WagerKind.Refund, { referenceExternalId: 'bet-wrong-owner' });
    const result = processor.process(refund, wallet, { ledgerEntryId: 'ledger-invalid-ref', reference: bet, at: now });

    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') throw new Error('Expected rejected result');
    expect(result.failureCode).toBe(WagerFailureCode.InvalidReference);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('rejects a second reversal of the same kind', () => {
    const wallet = makeWallet('75.00');
    const bet = makeTransaction(WagerKind.Bet, { externalId: 'bet-duplicate-refund', amount: '25.00' });
    bet.markProcessed(money('75.00'), now);
    const refund = makeTransaction(WagerKind.Refund, { amount: '25.00', referenceExternalId: 'bet-duplicate-refund' });
    const result = processor.process(refund, wallet, {
      ledgerEntryId: 'ledger-duplicate-refund', reference: bet,
      alreadyReversedBySameKind: true, at: now
    });

    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') throw new Error('Expected rejected result');
    expect(result.failureCode).toBe(WagerFailureCode.ReferenceAlreadyReversed);
    expect(wallet.balance.toString()).toBe('75.00');
  });

  test('rejects a reversal amount that differs from its reference', () => {
    const wallet = makeWallet('75.00');
    const bet = makeTransaction(WagerKind.Bet, { externalId: 'bet-different-amount', amount: '25.00' });
    bet.markProcessed(money('75.00'), now);
    const refund = makeTransaction(WagerKind.Refund, { amount: '24.99', referenceExternalId: 'bet-different-amount' });
    const result = processor.process(refund, wallet, { ledgerEntryId: 'ledger-different-amount', reference: bet, at: now });

    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') throw new Error('Expected rejected result');
    expect(result.failureCode).toBe(WagerFailureCode.InvalidReference);
    expect(wallet.balance.toString()).toBe('75.00');
  });
});
