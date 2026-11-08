import { Money } from '../shared/money.js';
import { InsufficientFundsError } from './insufficient-funds-error.js';
import { InvalidWalletOperationError } from './invalid-wallet-operation-error.js';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletBalanceChange {
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly version: number;
  readonly updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    private _updatedAt: Date
  ) {
    this._createdAt = new Date(createdAt.getTime());
  }

  private readonly _createdAt: Date;

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at?: Date;
  }): Wallet {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new InvalidWalletOperationError('Wallet id and playerId are required.');
    }
    if (!props.initialBalance.isPositive()) {
      throw new InvalidWalletOperationError('Initial balance must be greater than zero.');
    }

    const now = props.at ? new Date(props.at.getTime()) : new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now
    );
  }

  /** Rebuilds persisted state; it intentionally does not replay domain transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime())
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(amount: Money, at = new Date()): WalletBalanceChange {
    this.assertPositiveAmount(amount);
    this.assertSameCurrency(amount);

    const before = this._balance;
    const after = before.subtract(amount);
    if (after.isNegative()) {
      throw new InsufficientFundsError();
    }

    this.applyBalance(after, at);
    return { balanceBefore: before, balanceAfter: after, version: this._version, updatedAt: this.updatedAt };
  }

  credit(amount: Money, at = new Date()): WalletBalanceChange {
    this.assertPositiveAmount(amount);
    this.assertSameCurrency(amount);

    const before = this._balance;
    const after = before.add(amount);
    this.applyBalance(after, at);
    return { balanceBefore: before, balanceAfter: after, version: this._version, updatedAt: this.updatedAt };
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: this.updatedAt
    };
  }

  private applyBalance(nextBalance: Money, at: Date): void {
    this._balance = nextBalance;
    this._version += 1;
    this._updatedAt = new Date(at.getTime());
  }

  private assertPositiveAmount(amount: Money): void {
    if (!amount.isPositive()) {
      throw new InvalidWalletOperationError('Wallet movements must be greater than zero.');
    }
  }

  private assertSameCurrency(amount: Money): void {
    if (this.currency !== amount.currency) {
      throw new InvalidWalletOperationError(
        `Wallet currency ${this.currency} does not match operation currency ${amount.currency}.`
      );
    }
  }
}
