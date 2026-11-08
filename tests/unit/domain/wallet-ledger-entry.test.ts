import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/shared/money.js';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry.js';
import { InvalidWalletOperationError } from '../../../src/domain/wallet/invalid-wallet-operation-error.js';

const money = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('WalletLedgerEntry', () => {
  test('creates a balanced debit entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1', walletId: 'wallet-1', transactionId: 'transaction-1',
      direction: LedgerDirection.Debit, money: money('25.00'),
      balanceBefore: money('100.00'), balanceAfter: money('75.00'), walletVersion: 2
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('creates a balanced credit entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-2', walletId: 'wallet-1', transactionId: 'transaction-2',
      direction: LedgerDirection.Credit, money: money('25.00'),
      balanceBefore: money('75.00'), balanceAfter: money('100.00'), walletVersion: 2
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('does not expose a mutable creation date', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const entry = WalletLedgerEntry.create({
      id: 'entry-date', walletId: 'wallet-1', transactionId: 'transaction-date',
      direction: LedgerDirection.Credit, money: money('1.00'),
      balanceBefore: money('0.00'), balanceAfter: money('1.00'), walletVersion: 1, createdAt
    });
    entry.createdAt.setUTCFullYear(1999);
    expect(entry.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('rejects an unbalanced entry', () => {
    expect(() => WalletLedgerEntry.create({
      id: 'entry-3', walletId: 'wallet-1', transactionId: 'transaction-3',
      direction: LedgerDirection.Debit, money: money('25.00'),
      balanceBefore: money('100.00'), balanceAfter: money('80.00'), walletVersion: 2
    })).toThrow(InvalidWalletOperationError);
  });
});
