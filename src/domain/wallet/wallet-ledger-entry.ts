import { Money } from '../shared/money.js';
import { InvalidWalletOperationError } from './invalid-wallet-operation-error.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT'
}

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Wallet aggregate version associated with this balance-changing entry. */
  readonly walletVersion: number;
  readonly createdAt?: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    createdAt: Date
  ) {
    this._createdAt = new Date(createdAt.getTime());
  }

  private readonly _createdAt: Date;

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt ? new Date(props.createdAt.getTime()) : new Date()
    );

    if (!entry.id || !entry.walletId || !entry.transactionId) {
      throw new InvalidWalletOperationError('Ledger entry identifiers are required.');
    }
    if (![LedgerDirection.Debit, LedgerDirection.Credit].includes(entry.direction)) {
      throw new InvalidWalletOperationError('Ledger direction must be DEBIT or CREDIT.');
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvalidWalletOperationError('Ledger walletVersion must be a positive integer.');
    }
    if (!entry.money.isPositive()) {
      throw new InvalidWalletOperationError('Ledger amount must be greater than zero.');
    }
    if (entry.money.currency !== entry.balanceBefore.currency || entry.money.currency !== entry.balanceAfter.currency) {
      throw new InvalidWalletOperationError('Ledger amounts and balances must use the same currency.');
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new InvalidWalletOperationError('Ledger balances cannot be negative.');
    }
    if (!entry.isBalanced()) {
      throw new InvalidWalletOperationError('Ledger entry balance arithmetic is inconsistent.');
    }

    return entry;
  }

  /** Rebuilds an immutable ledger record without replaying a balance transition. */
  static rehydrate(state: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt ? new Date(state.createdAt.getTime()) : new Date()
    );
  }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter)
      && !this.balanceBefore.isNegative()
      && !this.balanceAfter.isNegative();
  }
}
