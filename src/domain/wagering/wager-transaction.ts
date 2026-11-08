import { Money } from '../shared/money.js';
import { DomainError } from '../shared/domain-error.js';

export enum WagerKind {
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK'
}

export enum WagerStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED'
}

export enum WagerFailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalWouldCauseNegativeBalance = 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE'
}

export class WagerTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_WAGER_TRANSACTION_STATE');
  }
}

export class InvalidWagerTransactionError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_WAGER_TRANSACTION');
  }
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly amount: Money;
  readonly referenceExternalTransactionId?: string | null;
  readonly createdAt?: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'createdAt'> {
  readonly status: WagerStatus;
  readonly failureCode: string | null;
  readonly referenceTransactionId: string | null;
  readonly responseBalance: Money | null;
  readonly processedAt: Date | null;
  readonly createdAt: Date;
}

const REVERSAL_KINDS = new Set<WagerKind>([WagerKind.Refund, WagerKind.Rollback]);
const TERMINAL_STATUSES = new Set<WagerStatus>([
  WagerStatus.Processed,
  WagerStatus.Rejected,
  WagerStatus.Failed
]);

/** Domain aggregate for one provider operation. Terminal states are immutable. */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerKind,
    public readonly amount: Money,
    public readonly referenceExternalTransactionId: string | null,
    private _status: WagerStatus,
    private _failureCode: string | null,
    private _referenceTransactionId: string | null,
    private _responseBalance: Money | null,
    createdAt: Date,
    processedAt: Date | null
  ) {
    this._createdAt = new Date(createdAt.getTime());
    this._processedAt = processedAt ? new Date(processedAt.getTime()) : null;
  }

  private readonly _createdAt: Date;
  private _processedAt: Date | null;

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const required: Array<[string, string]> = [
      ['id', props.id],
      ['providerId', props.providerId],
      ['externalTransactionId', props.externalTransactionId],
      ['idempotencyKey', props.idempotencyKey],
      ['walletId', props.walletId],
      ['playerId', props.playerId],
      ['roundId', props.roundId],
      ['gameId', props.gameId]
    ];

    for (const [field, value] of required) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new InvalidWagerTransactionError(`${field} is required.`);
      }
    }

    if (!Object.values(WagerKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError('Unsupported wager kind.');
    }
    if (!props.amount.isPositive()) {
      throw new InvalidWagerTransactionError('Wager amount must be greater than zero.');
    }
    if (!/^[0-9a-f]{64}$/.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError('payloadHash must be a lowercase SHA-256 hex digest.');
    }

    const referenceId = props.referenceExternalTransactionId?.trim() || null;
    if (REVERSAL_KINDS.has(props.kind) && !referenceId) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a reference transaction.`);
    }
    if (referenceId && props.kind !== WagerKind.Win && !REVERSAL_KINDS.has(props.kind)) {
      throw new InvalidWagerTransactionError(`${props.kind} cannot contain a reference transaction.`);
    }
    if (referenceId === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('A transaction cannot reference itself.');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.amount,
      referenceId,
      WagerStatus.Pending,
      null,
      null,
      null,
      props.createdAt ?? new Date(),
      null
    );
  }

  /** Rehydrates persisted state without replaying historical transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    if (!Object.values(WagerKind).includes(state.kind) || !Object.values(WagerStatus).includes(state.status)) {
      throw new InvalidWagerTransactionError('Persisted transaction has an unsupported kind or status.');
    }
    if (!state.id.trim() || !state.providerId.trim() || !state.externalTransactionId.trim()
      || !state.idempotencyKey.trim() || !state.walletId.trim() || !state.playerId.trim()
      || !state.roundId.trim() || !state.gameId.trim()) {
      throw new InvalidWagerTransactionError('Persisted transaction is missing a required identifier.');
    }
    if (!/^[0-9a-f]{64}$/.test(state.payloadHash) || !state.amount.isPositive()) {
      throw new InvalidWagerTransactionError('Persisted transaction has an invalid hash or amount.');
    }
    if (REVERSAL_KINDS.has(state.kind) && !state.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${state.kind} requires a persisted reference.`);
    }
    if (state.status === WagerStatus.PendingReference && !state.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError('Pending-reference transaction must have a reference.');
    }
    if (TERMINAL_STATUSES.has(state.status) !== Boolean(state.processedAt)) {
      throw new InvalidWagerTransactionError('Only terminal transactions may have processedAt, and every terminal transaction must have it.');
    }
    if ((state.status === WagerStatus.Rejected || state.status === WagerStatus.Failed) && !state.failureCode) {
      throw new InvalidWagerTransactionError('Rejected or failed transaction must have a failure code.');
    }
    if (state.status === WagerStatus.Processed && (!state.responseBalance || state.failureCode)) {
      throw new InvalidWagerTransactionError('Processed transaction must have a response balance and no failure code.');
    }
    if (state.status === WagerStatus.Rejected && !state.responseBalance) {
      throw new InvalidWagerTransactionError('Rejected transaction must preserve its response balance.');
    }
    if (state.referenceExternalTransactionId && state.status === WagerStatus.Processed && !state.referenceTransactionId) {
      throw new InvalidWagerTransactionError('Processed transaction with an external reference must preserve its resolved reference id.');
    }
    if (state.responseBalance && (state.responseBalance.isNegative() || state.responseBalance.currency !== state.amount.currency)) {
      throw new InvalidWagerTransactionError('Persisted response balance has invalid sign or currency.');
    }

    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.amount,
      state.referenceExternalTransactionId ?? null,
      state.status,
      state.failureCode,
      state.referenceTransactionId,
      state.responseBalance,
      state.createdAt,
      state.processedAt
    );
  }

  get status(): WagerStatus {
    return this._status;
  }

  get failureCode(): string | null {
    return this._failureCode;
  }

  get referenceTransactionId(): string | null {
    return this._referenceTransactionId;
  }

  get responseBalance(): Money | null {
    return this._responseBalance;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get processedAt(): Date | null {
    return this._processedAt ? new Date(this._processedAt.getTime()) : null;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  markPendingReference(): void {
    this.assertResolvable();
    if (!this.referenceExternalTransactionId) {
      throw new WagerTransactionStateError('A transaction without a reference cannot become PENDING_REFERENCE.');
    }
    this._status = WagerStatus.PendingReference;
  }

  markProcessed(balance: Money, at = new Date(), referenceTransactionId?: string | null): void {
    this.assertResolvable();
    this.assertResponseBalance(balance);
    if (this.referenceExternalTransactionId && !referenceTransactionId) {
      throw new WagerTransactionStateError(`${this.kind} cannot be processed without its resolved reference.`);
    }
    this._status = WagerStatus.Processed;
    this._failureCode = null;
    this._referenceTransactionId = referenceTransactionId ?? null;
    this._responseBalance = balance;
    this._processedAt = new Date(at.getTime());
  }

  reject(failureCode: WagerFailureCode | string, balance: Money, at = new Date()): void {
    this.assertResolvable();
    if (!failureCode.trim()) {
      throw new WagerTransactionStateError('A rejected transaction must have a failure code.');
    }
    this.assertResponseBalance(balance);
    this._status = WagerStatus.Rejected;
    this._failureCode = failureCode;
    this._responseBalance = balance;
    this._processedAt = new Date(at.getTime());
  }

  fail(failureCode: string, at = new Date()): void {
    this.assertResolvable();
    if (!failureCode.trim()) {
      throw new WagerTransactionStateError('A failed transaction must have a failure code.');
    }
    this._status = WagerStatus.Failed;
    this._failureCode = failureCode;
    this._processedAt = new Date(at.getTime());
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      amount: this.amount,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      status: this.status,
      failureCode: this.failureCode,
      referenceTransactionId: this.referenceTransactionId,
      responseBalance: this.responseBalance,
      createdAt: this.createdAt,
      processedAt: this.processedAt
    };
  }

  private assertResolvable(): void {
    if (this.isTerminal) {
      throw new WagerTransactionStateError(`Transaction in ${this._status} is terminal and cannot be changed.`);
    }
  }

  private assertResponseBalance(balance: Money): void {
    if (balance.isNegative() || balance.currency !== this.amount.currency) {
      throw new WagerTransactionStateError('Response balance must be non-negative and use the transaction currency.');
    }
  }
}
