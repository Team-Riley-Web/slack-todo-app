/**
 * Task priority: P0 Critical, P1 High, P2 Medium, P3 Low, or none.
 *
 * The labels ARE the sort keys. 'P0' < 'P1' < 'P2' < 'P3' lexically, in exactly
 * the order they rank, so `ORDER BY priority NULLS LAST` in SQL and a plain
 * string compare in TypeScript both produce the required order without a
 * lookup table. Nothing can drift between how a priority is displayed, stored
 * and sorted, because they are the same four bytes throughout.
 */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  P0: 'Critical',
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};

/** How a priority reads in a picker: "P0 — Critical". */
export function priorityChoice(priority: Priority): string {
  return `${priority} — ${PRIORITY_LABELS[priority]}`;
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

/**
 * The one place a caller's priority becomes a stored priority.
 *
 * Absent, null and empty string all mean Unprioritized -- a form sends `''` for
 * "no priority" and JSON sends `null`, and they must not disagree. Anything
 * else that is not one of the four is a mistake and throws, rather than being
 * quietly dropped to null: a typo'd `P7` reaching storage as "no priority"
 * would look exactly like a task nobody prioritised.
 */
export class InvalidPriorityError extends Error {
  constructor(readonly value: unknown) {
    super(
      `Invalid priority ${JSON.stringify(value)}. ` +
      `Use one of ${PRIORITIES.join(', ')}, or none.`
    );
    this.name = 'InvalidPriorityError';
  }
}

export function parsePriority(value: unknown): Priority | null {
  if (value === undefined || value === null || value === '') return null;
  if (isPriority(value)) return value;
  throw new InvalidPriorityError(value);
}

/**
 * Rank for in-memory sorting, matching `ORDER BY priority NULLS LAST`.
 * Unprioritized ranks last rather than first, which is what a bare string
 * compare on `null` would otherwise give you.
 */
export function priorityRank(priority: Priority | null | undefined): number {
  return priority ? PRIORITIES.indexOf(priority) : PRIORITIES.length;
}

/** Comparator for the shared ordering. Ties are left to the caller. */
export function comparePriority(
  a: Priority | null | undefined, b: Priority | null | undefined
): number {
  return priorityRank(a) - priorityRank(b);
}
