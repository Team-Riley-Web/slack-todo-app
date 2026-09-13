import { DateTime } from 'luxon';
import type { Priority, Space, Task } from '@tr/task-core';

/** Slack caps option.text at 75 chars; `~…~` costs 2, leaving 72 for the title. */
export const LABEL_BUDGET = 72;
/** Slack caps option.description at 75 chars. */
export const DESCRIPTION_BUDGET = 75;

export interface MetaOpts {
  timeZone: string;
  /**
   * Kept for callers that still pass it. The meta line no longer renders an
   * assignee: in a workspace where nearly every task is yours, repeating
   * "Joshua" on every row is noise, not information. Who did what is still in
   * the task's event history and on the web UI.
   */
  assigneeLabels?: Record<string, string>;
  /**
   * False when a Space heading already sits above this task, so the Space is
   * not repeated on every row beneath it.
   */
  showSpace?: boolean;
  /**
   * Render version, stamped into each checkbox block_id so an interaction can
   * be matched to the render the clicking client saw. Defaults to 1.
   */
  version?: number;
}

/**
 * Display-only. Counts code points, never UTF-16 units — `str.slice` can split
 * a surrogate pair and corrupt a character. Never written back to storage.
 *
 * `budget` shrinks when something is prefixed to the label. A `[P0] ` tag costs
 * five characters, and Slack rejects the whole message if option.text runs past
 * 75 — so the prefix has to come OUT of the title's allowance, not be added on
 * top of it.
 */
export function truncateLabel(
  title: string, budget: number = LABEL_BUDGET
): { label: string; truncated: boolean } {
  const room = Math.max(1, Math.floor(budget));
  const points = [...title];
  if (points.length <= room) return { label: title, truncated: false };
  return { label: `${points.slice(0, room).join('')}…`, truncated: true };
}

/**
 * The compact priority tag shown ahead of a title: `[P0] `, or nothing.
 *
 * A tag rather than a word, and nothing at all for an unprioritized task, so a
 * list of mostly-unprioritized work does not grow a column of "None".
 */
export function priorityTag(priority: Priority | null | undefined): string {
  return priority ? `[${priority}] ` : '';
}

/**
 * Slack's native date token. Renders in the VIEWER's own timezone, which
 * server-side formatting cannot do.
 *
 * mrkdwn ONLY. A plain_text field renders this literally, so it must never be
 * used in a checkbox option.description - see metaLine below.
 */
export function slackDate(d: Date, token = '{date_short}', timeZone = 'UTC'): string {
  const seconds = Math.floor(d.getTime() / 1000);
  const fallback = DateTime.fromJSDate(d, { zone: timeZone }).toFormat('LLL d, yyyy');
  return `<!date^${seconds}^${token}|${fallback}>`;
}

/**
 * Native user mention. Slack renders the person's current display name and
 * avatar, so no label configuration is needed and it can never go stale.
 * mrkdwn ONLY, same constraint as slackDate.
 */
export function slackUser(userId: string | null | undefined): string | null {
  return userId ? `<@${userId}>` : null;
}

function shortSpace(name: string): string {
  return name.startsWith('Client - ') ? name.slice('Client - '.length) : name;
}

function fmtDate(d: Date, timeZone: string): string {
  return DateTime.fromJSDate(d, { zone: timeZone }).toFormat('LLL d');
}

function clip(text: string, budget: number): string {
  const points = [...text];
  return points.length <= budget ? text : `${points.slice(0, budget - 1).join('')}…`;
}

/**
 * plain_text, max 75. Compaction order when over budget: drop the assignee,
 * then clip. Meta is derived data and is not covered by the exact-title guarantee.
 *
 * This is the one surface that CANNOT use Slack's native date tokens or user
 * mentions: a checkbox option.description is typed `PlainTextElement`, and
 * plain_text renders `<!date^...>` and `<@U...>` as literal source. Keeping the
 * checkbox on the left is what confines the meta line here, so the trade is
 * deliberate: native left-side checkbox, server-formatted meta. Every mrkdwn
 * surface uses slackDate and slackUser instead.
 */
export function metaLine(task: Task, space: Space, opts: MetaOpts): string {
  const parts: string[] = [];

  /*
   * A completed row carries no "Completed <date>" line. The checked box and
   * the strikethrough already say it, and Slack renders an option description
   * at the same size and nearly the same weight as the title, so the line read
   * as a second row of text under every finished task. The date is still on
   * the web UI and in the Completed report.
   */
  // Skipped when a Space heading is already above the row.
  if (opts.showSpace !== false) parts.push(shortSpace(space.name));

  if (task.status !== 'completed') {
    if (task.due_at) parts.push(`due ${fmtDate(task.due_at, opts.timeZone)}`);
    if (task.status === 'waiting') {
      parts.push(task.waiting_on ? `waiting on ${task.waiting_on}` : 'waiting');
    }
  }

  const line = parts.join(' · ');
  return [...line].length <= DESCRIPTION_BUDGET ? line : clip(line, DESCRIPTION_BUDGET);
}
