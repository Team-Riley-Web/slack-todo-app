/**
 * Who can be assigned a task, by name.
 *
 * A Slack user id is unreadable -- nobody should have to know that
 * U0BU0V0850Q is them -- so every surface shows a name and stores the id.
 * Until now exactly one name was configurable, through the
 * DEFAULT_ASSIGNEE_SLACK_ID / DEFAULT_ASSIGNEE_LABEL pair, because there was
 * exactly one person. A second person needs a map.
 *
 * `ASSIGNEE_LABELS` holds it: `U0BU0V0850Q=Joshua,U0BT6HDBYBC=Rachael`. The
 * older pair still works and still names the DEFAULT assignee for capture --
 * the one a task gets when nobody is named -- so this is additive: an
 * existing .env keeps working untouched.
 *
 * Parsing lives here, in task-core, rather than in each app: the web app and
 * the Slack app both need the same answer, and two parsers would eventually
 * disagree about a trailing comma.
 */

/** Slack ids are uppercase alphanumerics; anything else is not an id. */
const ID = /^[A-Z0-9]+$/;

/**
 * Reads `id=Name,id=Name` into a map.
 *
 * Malformed entries are skipped rather than thrown on. This value comes from
 * the environment, and a stray comma should not stop the app from booting --
 * it should cost one name.
 */
export function parseAssigneeLabels(
  raw: string | undefined | null
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const at = entry.indexOf('=');
    if (at < 0) continue;
    const id = entry.slice(0, at).trim();
    const label = entry.slice(at + 1).trim();
    // A label containing '=' is fine; only the first one separates.
    if (!id || !label || !ID.test(id)) continue;
    out[id] = label;
  }
  return out;
}

/**
 * Every assignee to offer, as `[id, label]` pairs sorted by label.
 *
 * `inUse` are the ids that actually appear on tasks. They are included even
 * when unnamed, so a task assigned to someone who is not in the config still
 * shows a filter that can find it -- with the raw id as its own label, which
 * is ugly on purpose: it reads as something to go and configure.
 */
export function assigneeChoices(
  labels: Record<string, string>,
  inUse: readonly string[] = []
): Array<[string, string]> {
  const ids = new Set([...Object.keys(labels), ...inUse]);
  return [...ids]
    .map((id) => [id, labels[id] ?? id] as [string, string])
    .sort((a, b) => a[1].localeCompare(b[1], 'en', { sensitivity: 'base' }));
}
