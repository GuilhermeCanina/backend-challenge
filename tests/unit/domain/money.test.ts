import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/shared/money.js';
import { CurrencyMismatchError } from '../../../src/domain/shared/currency-mismatch-error.js';
import { InvalidMoneyError } from '../../../src/domain/shared/invalid-money-error.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('adds and subtracts using exact decimal arithmetic', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(brl('1.00').subtract(brl('0.90')).toJSON()).toEqual({ amount: '0.10', currency: 'BRL' });
  });

  test('serializes with exactly two decimal places', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('distinguishes strictly positive values from zero', () => {
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isNegative()).toBe(false);
  });

  test('supports a negative intermediate result without accepting negative input', () => {
    expect(brl('1.00').subtract(brl('2.00')).isNegative()).toBe(true);
    expect(() => brl('-1.00')).toThrow(InvalidMoneyError);
  });

  test.each(['', '1', '1.0', '1.000', '1e3', 'NaN', 'Infinity', '1000000000000000000.00']) (
    'rejects invalid amount %s', (amount: string) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    }
  );

  test('rejects malformed or unsupported currencies', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'ZZZ' })).toThrow(InvalidMoneyError);
  });

  test('rejects arithmetic across different currencies', () => {
    expect(() => brl('1.00').add(Money.from({ amount: '1.00', currency: 'USD' })))
      .toThrow(CurrencyMismatchError);
  });

  test('is immutable', () => {
    const original = brl('5.00');
    const increased = original.add(brl('2.00'));
    expect(original.toString()).toBe('5.00');
    expect(increased.toString()).toBe('7.00');
  });
});
