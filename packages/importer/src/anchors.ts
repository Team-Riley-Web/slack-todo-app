/**
 * The five recurring Personal Daily Anchors. They are tracked outside this
 * system in a Google Sheet, and must not enter it through an import.
 *
 * Matched on the exact title only. A task whose title merely contains one of
 * these words is a normal task and is imported normally.
 */
export const DAILY_ANCHORS = [
  'Meditate',
  'Exercise',
  'Journal',
  'Cold Exposure',
  'Vocal Warm-Ups',
] as const;

const EXACT = new Set<string>(DAILY_ANCHORS.map((a) => a.toLowerCase()));

export function isDailyAnchor(title: string): boolean {
  return EXACT.has(title.trim().toLowerCase());
}
