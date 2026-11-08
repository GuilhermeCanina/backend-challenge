import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../../domain/shared/money.js';
import type { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry.js';

export interface IntegrationEventProps<T> {
  readonly eventId?: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt?: Date;
  readonly data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId ?? randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt ? new Date(props.occurredAt) : new Date();
    this.data = Object.freeze({ ...props.data });
  }

  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data
    };
  }
}

export interface WagerTransactionEventData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly kind: string;
  readonly status: string;
  readonly balance: MoneyProps | null;
  readonly failureCode?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(props: IntegrationEventProps<WagerTransactionEventData>): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) { super(props); }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(props: IntegrationEventProps<WagerTransactionEventData>): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) { super(props); }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(props: IntegrationEventProps<WagerTransactionEventData>): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) { super(props); }
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(props: IntegrationEventProps<WalletBalanceChangedData>): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); }
}
