export class ImportParseError extends Error {
  constructor(message: string, readonly rowNumber?: number) {
    super(rowNumber === undefined ? message : `row ${rowNumber}: ${message}`);
    this.name = 'ImportParseError';
  }
}

/**
 * Raised when a batch is asked to do something its state does not permit —
 * importing before confirmation, confirming twice, rolling back something that
 * was never imported. This is what makes "explicit confirmation required" a
 * property of the state machine rather than a convention.
 */
export class ImportStateError extends Error {
  constructor(readonly batchId: string, readonly state: string, expected: string) {
    super(`batch ${batchId} is ${state}, expected ${expected}`);
    this.name = 'ImportStateError';
  }
}

export class ImportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportLimitError';
  }
}
