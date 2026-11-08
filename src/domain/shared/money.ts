import { Decimal } from 'decimal.js';
import { CurrencyMismatchError } from './currency-mismatch-error.js';
import { InvalidMoneyError } from './invalid-money-error.js';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

const MONEY_DECIMAL = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30
});

const AMOUNT_PATTERN = /^\d{1,18}\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

/** Immutable monetary value. External values are accepted only as fixed-scale strings. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError('Amount must be a non-negative decimal string with exactly two fraction digits.');
    }

    const currency = Money.validateCurrency(props.currency);
    const value = new MONEY_DECIMAL(props.amount);
    if (!value.isFinite() || value.isNegative()) {
      throw new InvalidMoneyError('Amount must be finite and non-negative.');
    }

    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return new Money(new MONEY_DECIMAL('0.00'), Money.validateCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromArithmetic(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromArithmetic(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromArithmetic(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    // decimal.js considers zero positive for its sign predicate; domain Money
    // requires strictly greater than zero for financial movements.
    return this.value.greaterThan('0');
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static validateCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Currency must be a three-letter uppercase ISO-4217 code.');
    }

    if (!SUPPORTED_CURRENCIES.has(currency)) {
      throw new InvalidMoneyError(`Unsupported ISO-4217 currency code: ${currency}.`);
    }

    return currency;
  }

  private static fromArithmetic(value: Decimal, currency: string): Money {
    if (!value.isFinite() || value.decimalPlaces() > 2) {
      throw new InvalidMoneyError('Arithmetic produced an invalid monetary value.');
    }
    return new Money(value, currency);
  }
}
