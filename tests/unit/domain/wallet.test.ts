import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/shared/money.js';
import { Wallet } from '../../../src/domain/wallet/wallet.js';
import { InsufficientFundsError } from '../../../src/domain/wallet/insufficient-funds-error.js';
import { InvalidWalletOperationError } from '../../../src/domain/wallet/invalid-wallet-operation-error.js';

const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });
const instant = new Date('2026-01-01T00:00:00.000Z');

describe('Wallet', () => {
  test('opens with version 1 and the requested initial balance', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00'), at: instant });
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.toISOString()).toBe(instant.toISOString());
  });

  test('debits with a balance snapshot and increments version once', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00'), at: instant });
    const result = wallet.debit(money('30.00'), new Date('2026-01-01T00:01:00.000Z'));
    expect(result.balanceBefore.toString()).toBe('100.00');
    expect(result.balanceAfter.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
  });

  test('rejects a debit that would make balance negative', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00') });
    expect(() => wallet.debit(money('10.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('does not expose mutable internal dates', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('1.00'), at: instant });
    const exposed = wallet.createdAt;
    exposed.setUTCFullYear(1999);
    expect(wallet.createdAt.toISOString()).toBe(instant.toISOString());
  });

  test('credits and increments version only when balance changes', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('1.00') });
    wallet.credit(money('12.50'));
    expect(wallet.balance.toString()).toBe('13.50');
    expect(wallet.version).toBe(2);
  });

  test('rejects zero movements and currency mismatch', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00') });
    expect(() => wallet.debit(money('0.00'))).toThrow(InvalidWalletOperationError);
    expect(() => Wallet.open({ id: 'wallet-2', playerId: 'player-1', initialBalance: money('0.00') }))
      .toThrow(InvalidWalletOperationError);
    expect(() => wallet.credit(money('1.00', 'USD'))).toThrow(InvalidWalletOperationError);
  });
});
