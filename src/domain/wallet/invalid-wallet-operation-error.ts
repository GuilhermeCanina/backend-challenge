import { DomainError } from '../shared/domain-error.js';

export class InvalidWalletOperationError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_WALLET_OPERATION');
  }
}
