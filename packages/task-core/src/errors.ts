export class InvalidTaskIdError extends Error {
  constructor(readonly value: string) {
    super('Invalid task id');
    this.name = 'InvalidTaskIdError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Task not found: ${id}`);
    this.name = 'TaskNotFoundError';
  }
}

export class UnauthorizedError extends Error {
  constructor(readonly userId: string | undefined) {
    super('Not authorized');
    this.name = 'UnauthorizedError';
  }
}

export class UnknownSpaceError extends Error {
  constructor(readonly requested: string, readonly available: string[]) {
    super(
      `Unknown space: "${requested}". Valid spaces: ${available.join(', ')}`
    );
    this.name = 'UnknownSpaceError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guards every task entry point. Rejects before any SQL is issued. */
export function assertTaskId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new InvalidTaskIdError(String(id));
  }
  return id;
}
