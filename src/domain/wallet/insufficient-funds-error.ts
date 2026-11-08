import { DomainError } from '../shared/domain-error.js';

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('Wallet has insufficient funds for this debit.', 'INSUFFICIENT_FUNDS');
  }
}
