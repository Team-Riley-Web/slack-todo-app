import {
  calendarDaysFrom, DEFAULT_TIME_ZONE, type Space, type Task,
} from '@tr/task-core';
import { filtersToQuery, type TaskFilters } from '@/data/filters';

export interface DueLabel {
  text: string;
  /** Lets the row style an overdue task without re-deriving the reason. */
  tone: 'overdue' | 'soon' | 'normal';
}

/**
 * How a due date reads in a list. Relative for the next few days, then an
 * absolute date, because "in 43 days" is harder to act on than "Oct 23".
 */
/*
 * Days are counted in the app's zone (America/Chicago by default), not UTC.
 * They were UTC, which turned "Due today" into "Due tomorrow" at 7pm Chicago
 * time -- and inside the Today card that read as a bug in the card.
 */
export function dueLabel(
  task: Task, now = new Date(), timeZone: string = DEFAULT_TIME_ZONE
): DueLabel | null {
  if (!task.due_at) return null;
  const days = calendarDaysFrom(task.due_at, now, timeZone);

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
      month: 'short', day: 'numeric', timeZone,
    })}`,
    tone: 'normal',
  };
}

/** How long a task has existed, for the waiting view's age column. */
export function ageInDays(
  task: Task, now = new Date(), timeZone: string = DEFAULT_TIME_ZONE
): number {
  return Math.max(0, calendarDaysFrom(now, task.created_at, timeZone));
}

export function ageLabel(
  task: Task, now = new Date(), timeZone: string = DEFAULT_TIME_ZONE
): string {
  const days = ageInDays(task, now, timeZone);
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

/** Opens the new-task pane over the view the user is already looking at. */
export function newTaskHref(
  basePath = '/', params: Record<string, string | string[] | undefined> = {}
): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // A stale error belongs to the previous submission, and an edit pane is
    // mutually exclusive with capture.
    if (key === 'newTask' || key === 'edit' || key === 'error' || value === undefined) continue;
    q.set(key, Array.isArray(value) ? (value[0] ?? '') : value);
  }
  q.set('newTask', '1');
  return `${basePath}?${q.toString()}`;
}

/** The same view with the new-task pane and any submission error closed. */
export function closeNewTaskHref(
  basePath = '/', params: Record<string, string | string[] | undefined> = {}
): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'newTask' || key === 'error' || value === undefined) continue;
    q.set(key, Array.isArray(value) ? (value[0] ?? '') : value);
  }
  const s = q.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/**
 * Capture follows the current Space when there is one, otherwise Inbox.
 * The final fallback only covers a malformed database with no Inbox row.
 */
export function newTaskSpace(
  spaces: Space[], activeSlug: string | undefined | null
): Space | null {
  return spaceBySlug(spaces, activeSlug)
    ?? spaces.find((space) => space.is_inbox)
    ?? spaces[0]
    ?? null;
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
