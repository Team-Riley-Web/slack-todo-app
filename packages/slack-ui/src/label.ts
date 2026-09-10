import { DateTime } from 'luxon';
import type { Space, Task } from '@tr/task-core';

/** Slack caps option.text at 75 chars; `~…~` costs 2, leaving 72 for the title. */
export const LABEL_BUDGET = 72;
/** Slack caps option.description at 75 chars. */
export const DESCRIPTION_BUDGET = 75;

export interface MetaOpts {
  timeZone: string;
  assigneeLabels?: Record<string, string>;
  /**
   * Render version, stamped into each checkbox block_id so an interaction can
   * be matched to the render the clicking client saw. Defaults to 1.
   */
  version?: number;
}

/**
 * Display-only. Counts code points, never UTF-16 units — `str.slice` can split
 * a surrogate pair and corrupt a character. Never written back to storage.
 */
export function truncateLabel(title: string): { label: string; truncated: boolean } {
  const points = [...title];
  if (points.length <= LABEL_BUDGET) return { label: title, truncated: false };
  return { label: `${points.slice(0, LABEL_BUDGET).join('')}…`, truncated: true };
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
  const assignee = task.assignee_id
    ? opts.assigneeLabels?.[task.assignee_id]
    : undefined;

  const build = (withAssignee: boolean): string => {
    const parts: string[] = [];
    if (task.status === 'completed' && task.completed_at) {
      parts.push(`Completed ${fmtDate(task.completed_at, opts.timeZone)}`);
    }
    parts.push(shortSpace(space.name));
    if (task.status !== 'completed') {
      if (withAssignee && assignee) parts.push(assignee);
      if (task.due_at) parts.push(`due ${fmtDate(task.due_at, opts.timeZone)}`);
      if (task.status === 'waiting') {
        parts.push(task.waiting_on ? `waiting on ${task.waiting_on}` : 'waiting');
      }
    }
    return parts.join(' · ');
  };

  for (const candidate of [build(true), build(false)]) {
    if ([...candidate].length <= DESCRIPTION_BUDGET) return candidate;
  }
  return clip(build(false), DESCRIPTION_BUDGET);
}
