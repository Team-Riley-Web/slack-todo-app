import { parseAssigneeLabels } from '@tr/task-core';

/**
 * The only environment values any page is allowed to read.
 *
 * Deliberately a narrow allowlist rather than reaching into process.env from a
 * component: a page cannot render a secret it has no way to obtain.
 * `apps/web/src/no-secrets.test.ts` asserts nothing else is read.
 */
/**
 * Everyone who can be assigned a task, by name.
 *
 * ASSIGNEE_LABELS holds the map; the older DEFAULT_ASSIGNEE_* pair is folded
 * in so an existing .env keeps working, and loses to the map when both name
 * the same id -- the map is the more specific statement.
 */
export function assigneeLabels(): Record<string, string> {
  const id = process.env.DEFAULT_ASSIGNEE_SLACK_ID?.trim();
  const label = process.env.DEFAULT_ASSIGNEE_LABEL?.trim();
  return {
    ...(id && label ? { [id]: label } : {}),
    ...parseAssigneeLabels(process.env.ASSIGNEE_LABELS),
  };
}

/**
 * Who a task belongs to when nobody says otherwise.
 *
 * The Slack command assigns this, so the web form does too -- otherwise the
 * same task is assigned or unassigned depending on where it was typed.
 */
export function defaultAssigneeId(): string | null {
  return process.env.DEFAULT_ASSIGNEE_SLACK_ID?.trim() || null;
}

export function authorizedUserIds(): string[] {
  return (process.env.AUTHORIZED_SLACK_USER_IDS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export function timeZone(): string {
  return process.env.DEFAULT_TIMEZONE?.trim() || 'America/Chicago';
}
