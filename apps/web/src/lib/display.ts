import type { Space, Task } from '@tr/task-core';
import { filtersToQuery, type TaskFilters } from '@/data/filters';

/** Calendar-day difference in UTC, so a time of day never shifts the answer. */
function daysBetween(a: Date, b: Date): number {
  const dayA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const dayB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((dayA - dayB) / 86_400_000);
}

export interface DueLabel {
  text: string;
  /** Lets the row style an overdue task without re-deriving the reason. */
  tone: 'overdue' | 'soon' | 'normal';
}

/**
 * How a due date reads in a list. Relative for the next few days, then an
 * absolute date, because "in 43 days" is harder to act on than "Oct 23".
 */
export function dueLabel(task: Task, now = new Date()): DueLabel | null {
  if (!task.due_at) return null;
  const days = daysBetween(task.due_at, now);

  if (days < 0) {
    const ago = Math.abs(days);
    return {
      text: ago === 1 ? 'Overdue by 1 day' : `Overdue by ${ago} days`,
      tone: 'overdue',
    };
  }
  if (days === 0) return { text: 'Due today', tone: 'soon' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (days <= 7) return { text: `Due in ${days} days`, tone: 'soon' };

  return {
    text: `Due ${task.due_at.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    })}`,
    tone: 'normal',
  };
}

/** How long a task has existed, for the waiting view's age column. */
export function ageInDays(task: Task, now = new Date()): number {
  return Math.max(0, daysBetween(now, task.created_at));
}

export function ageLabel(task: Task, now = new Date()): string {
  const days = ageInDays(task, now);
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 30) return `${days} days`;
  const months = Math.round(days / 30);
  return months === 1 ? '1 month' : `${months} months`;
}

/**
 * Editing is a query parameter on the list you are already looking at, not a
 * separate route.
 *
 * A route swapped the whole page out, so the list vanished behind the edit
 * pane. As a parameter the list stays rendered underneath and the pane sits
 * over it, while the URL is still linkable and the back button still works —
 * without the complexity of intercepting routes or any client JavaScript.
 *
 * Existing filters are carried through, so cancelling returns you to the view
 * you were filtering.
 */
export function taskEditHref(
  task: Task, basePath = '/', params: Record<string, string | string[] | undefined> = {}
): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'edit' || value === undefined) continue;
    q.set(key, Array.isArray(value) ? (value[0] ?? '') : value);
  }
  q.set('edit', task.id);
  return `${basePath}?${q.toString()}`;
}

/** The same view with the edit pane closed. */
export function closeEditHref(
  basePath = '/', params: Record<string, string | string[] | undefined> = {}
): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'edit' || value === undefined) continue;
    q.set(key, Array.isArray(value) ? (value[0] ?? '') : value);
  }
  const s = q.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/** True for a Space stored with the "Client - " prefix. */
export function isClientSpace(space: Space): boolean {
  return space.name.startsWith('Client - ');
}

export function spaceHref(space: Space): string {
  return `/spaces/${space.slug}`;
}

export function filterHref(path: string, filters: TaskFilters): string {
  return `${path}${filtersToQuery(filters)}`;
}

/** Drops the "Client - " prefix, which is noise once you are inside the app. */
export function shortSpaceName(space: Space): string {
  return space.name.startsWith('Client - ')
    ? space.name.slice('Client - '.length)
    : space.name;
}

/**
 * The Space a `?space=<slug>` filter names, or null when it names nothing.
 *
 * Null for an unknown slug on purpose: a stale link should fall back to the
 * unfiltered view's own heading rather than title the page after a Space that
 * does not exist.
 */
export function spaceBySlug(
  spaces: Space[], slug: string | undefined | null
): Space | null {
  if (!slug) return null;
  return spaces.find((s) => s.slug === slug) ?? null;
}
