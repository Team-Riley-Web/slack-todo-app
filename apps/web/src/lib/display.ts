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

export function taskEditHref(task: Task): string {
  return `/tasks/${task.id}/edit`;
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
