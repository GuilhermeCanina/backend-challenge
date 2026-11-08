import { DomainError } from './domain-error.js';

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}.`, 'CURRENCY_MISMATCH');
  }
}
