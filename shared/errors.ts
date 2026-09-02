/** Project error types with stable machine-readable codes. */

export class BookKaroError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BookKaroError';
    this.code = code;
  }
}

export class ValidationError extends BookKaroError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

export class NotImplementedError extends BookKaroError {
  constructor(message: string) {
    super('NOT_IMPLEMENTED', message);
    this.name = 'NotImplementedError';
  }
}

export class SafetyViolationError extends BookKaroError {
  constructor(message: string) {
    super('SAFETY_VIOLATION', message);
    this.name = 'SafetyViolationError';
  }
}
