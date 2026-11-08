import { Money } from '../shared/money.js';
import { InsufficientFundsError } from '../wallet/insufficient-funds-error.js';
import { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry.js';
import { Wallet } from '../wallet/wallet.js';
import {
  WagerFailureCode,
  WagerKind,
  WagerStatus,
  WagerTransaction,
  WagerTransactionStateError
} from './wager-transaction.js';

export interface ProcessWagerOptions {
  /** Required only for balance-changing operations. */
  readonly ledgerEntryId?: string;
  readonly at?: Date;
  readonly reference?: WagerTransaction | null;
  /** Backed by the database's unique (reference_transaction_id, kind) index. */
  readonly alreadyReversedBySameKind?: boolean;
}

export type WagerProcessingResult =
  | {
      readonly outcome: 'PROCESSED';
      readonly transaction: WagerTransaction;
      readonly ledgerEntry: WalletLedgerEntry | null;
      readonly balance: Money;
    }
  | {
      readonly outcome: 'REJECTED';
      readonly transaction: WagerTransaction;
      readonly failureCode: WagerFailureCode;
      readonly balance: Money;
    }
  | {
      readonly outcome: 'PENDING_REFERENCE';
      readonly transaction: WagerTransaction;
      readonly balance: Money;
    };

/** Pure orchestration of domain rules; persistence and locking belong to the application layer. */
export class WageringProcessor {
  process(
    transaction: WagerTransaction,
    wallet: Wallet,
    options: ProcessWagerOptions
  ): WagerProcessingResult {
    this.assertWalletMatches(transaction, wallet);

    if (transaction.isTerminal) {
      throw new WagerTransactionStateError(`Cannot process terminal transaction ${transaction.id} (${transaction.status}).`);
    }

    const referenceRequired = transaction.kind === WagerKind.Refund || transaction.kind === WagerKind.Rollback;
    const hasReference = Boolean(transaction.referenceExternalTransactionId);

    if ((referenceRequired || hasReference) && !options.reference) {
      transaction.markPendingReference();
      return { outcome: 'PENDING_REFERENCE', transaction, balance: wallet.balance };
    }

    if (options.reference) {
      const invalidReferenceCode = this.validateReference(transaction, options.reference);
      if (invalidReferenceCode) {
        return this.reject(transaction, wallet, invalidReferenceCode, options.at);
      }
      if ((transaction.kind === WagerKind.Refund || transaction.kind === WagerKind.Rollback)
        && options.alreadyReversedBySameKind) {
        return this.reject(transaction, wallet, WagerFailureCode.ReferenceAlreadyReversed, options.at);
      }
    }

    if (transaction.kind === WagerKind.Refund || transaction.kind === WagerKind.Rollback) {
      if (!options.reference) {
        transaction.markPendingReference();
        return { outcome: 'PENDING_REFERENCE', transaction, balance: wallet.balance };
      }
    }

    const now = options.at ? new Date(options.at.getTime()) : new Date();
    let ledgerEntry: WalletLedgerEntry | null = null;

    if (transaction.kind !== WagerKind.Loss) {
      const ledgerEntryId = options.ledgerEntryId;
      if (!ledgerEntryId?.trim()) {
        throw new WagerTransactionStateError('ledgerEntryId is required for balance-changing wager transactions.');
      }

      try {
        const direction = this.directionFor(transaction, options.reference);
        const change = direction === LedgerDirection.Debit
          ? wallet.debit(transaction.amount, now)
          : wallet.credit(transaction.amount, now);

        ledgerEntry = WalletLedgerEntry.create({
          id: ledgerEntryId,
          walletId: wallet.id,
          transactionId: transaction.id,
          direction,
          money: transaction.amount,
          balanceBefore: change.balanceBefore,
          balanceAfter: change.balanceAfter,
          walletVersion: change.version,
          createdAt: now
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          const failureCode = transaction.kind === WagerKind.Rollback
            ? WagerFailureCode.ReversalWouldCauseNegativeBalance
            : WagerFailureCode.InsufficientFunds;
          return this.reject(transaction, wallet, failureCode, now);
        }
        throw error;
      }
    }

    transaction.markProcessed(wallet.balance, now, options.reference?.id ?? null);
    return { outcome: 'PROCESSED', transaction, ledgerEntry, balance: wallet.balance };
  }

  private directionFor(
    transaction: WagerTransaction,
    reference?: WagerTransaction | null
  ): LedgerDirection {
    switch (transaction.kind) {
      case WagerKind.Bet:
        return LedgerDirection.Debit;
      case WagerKind.Win:
      case WagerKind.Refund:
        return LedgerDirection.Credit;
      case WagerKind.Rollback:
        if (!reference) throw new WagerTransactionStateError('ROLLBACK requires a resolved reference.');
        return reference.kind === WagerKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      case WagerKind.Loss:
        throw new WagerTransactionStateError('LOSS does not create a ledger entry.');
    }
  }

  private validateReference(
    transaction: WagerTransaction,
    reference: WagerTransaction
  ): WagerFailureCode | null {
    const sameIdentity = reference.providerId === transaction.providerId
      && reference.playerId === transaction.playerId
      && reference.walletId === transaction.walletId
      && reference.roundId === transaction.roundId
      && reference.amount.currency === transaction.amount.currency;

    if (!sameIdentity || reference.externalTransactionId !== transaction.referenceExternalTransactionId) {
      return WagerFailureCode.InvalidReference;
    }
    if (reference.id === transaction.id || reference.status !== WagerStatus.Processed) {
      return WagerFailureCode.InvalidReference;
    }
    if ((transaction.kind === WagerKind.Refund || transaction.kind === WagerKind.Rollback)
      && !reference.amount.equals(transaction.amount)) {
      return WagerFailureCode.InvalidReference;
    }

    if (transaction.kind === WagerKind.Win && reference.kind !== WagerKind.Bet) {
      return WagerFailureCode.InvalidReference;
    }
    if (transaction.kind === WagerKind.Refund && reference.kind !== WagerKind.Bet) {
      return WagerFailureCode.InvalidReference;
    }
    if (transaction.kind === WagerKind.Rollback && ![
      WagerKind.Bet,
      WagerKind.Win,
      WagerKind.Refund
    ].includes(reference.kind)) {
      return WagerFailureCode.InvalidReference;
    }

    return null;
  }

  private reject(
    transaction: WagerTransaction,
    wallet: Wallet,
    failureCode: WagerFailureCode,
    at = new Date()
  ): WagerProcessingResult {
    transaction.reject(failureCode, wallet.balance, at);
    return { outcome: 'REJECTED', transaction, failureCode, balance: wallet.balance };
  }

  private assertWalletMatches(transaction: WagerTransaction, wallet: Wallet): void {
    if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId || transaction.amount.currency !== wallet.currency) {
      throw new WagerTransactionStateError('Wager transaction does not belong to the supplied wallet/player/currency.');
    }
  }
}
