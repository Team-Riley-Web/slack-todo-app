/**
 * The only environment values any page is allowed to read.
 *
 * Deliberately a narrow allowlist rather than reaching into process.env from a
 * component: a page cannot render a secret it has no way to obtain.
 * `apps/web/src/no-secrets.test.ts` asserts nothing else is read.
 */
export function assigneeLabels(): Record<string, string> {
  const id = process.env.DEFAULT_ASSIGNEE_SLACK_ID?.trim();
  const label = process.env.DEFAULT_ASSIGNEE_LABEL?.trim();
  return id && label ? { [id]: label } : {};
}

export function authorizedUserIds(): string[] {
  return (process.env.AUTHORIZED_SLACK_USER_IDS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export function timeZone(): string {
  return process.env.DEFAULT_TIMEZONE?.trim() || 'America/Chicago';
}
