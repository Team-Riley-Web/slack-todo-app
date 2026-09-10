import { ImportParseError } from '../errors.js';
import type { Adapter, StagingRow } from '../types.js';

/**
 * Reads a Workast export.
 *
 * Verified against the real 21-task export in
 * `docs/workast-export-2026-09-09.json`, whose shape is
 * `{ categories: { "<category name>": [task, ...] } }`. A flat array or a
 * `tasks` array is also accepted, since a different export mode may produce
 * one and rejecting it would be unhelpful.
 *
 * Everything the canonical model has no column for — `details` up to 3,224
 * characters, `workast_url`, `canonical_source_id`, `tags`, `due_time`,
 * `due_timezone`, the `waiting` flag — is preserved in `sourceMetadata` so the
 * mapping step can use it and nothing is silently lost.
 */
interface WorkastTask {
  workast_task_id?: unknown;
  canonical_source_id?: unknown;
  title?: unknown;
  category?: unknown;
  status?: unknown;
  assignees?: unknown;
  waiting?: unknown;
  waiting_on?: unknown;
  due_date?: unknown;
  due_time?: unknown;
  due_timezone?: unknown;
  tags?: unknown;
  details?: unknown;
  workast_url?: unknown;
  [key: string]: unknown;
}

function orNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : value;
}

/** First assignee only: the canonical model has one assignee per task. */
function firstAssignee(assignees: unknown): string | null {
  if (!Array.isArray(assignees) || assignees.length === 0) return null;
  const first = assignees[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  return orNull(first.email) ?? orNull(first.name);
}

function collect(parsed: unknown): Array<{ task: WorkastTask; category: string | null }> {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;

    const categories = obj.categories;
    if (categories && typeof categories === 'object' && !Array.isArray(categories)) {
      const out: Array<{ task: WorkastTask; category: string | null }> = [];
      for (const [category, list] of Object.entries(categories as Record<string, unknown>)) {
        if (!Array.isArray(list)) {
          throw new ImportParseError(`category ${JSON.stringify(category)} is not a list`);
        }
        for (const task of list) out.push({ task: task as WorkastTask, category });
      }
      return out;
    }

    for (const key of ['tasks', 'records', 'items']) {
      const list = obj[key];
      if (Array.isArray(list)) {
        return (list as WorkastTask[]).map((task) => ({
          task, category: orNull(task.category),
        }));
      }
    }
  }

  if (Array.isArray(parsed)) {
    return (parsed as WorkastTask[]).map((task) => ({
      task, category: orNull(task.category),
    }));
  }

  throw new ImportParseError(
    'expected a Workast export with a categories object, or a tasks array'
  );
}

export const workastAdapter: Adapter = (input: string): StagingRow[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new ImportParseError(
      err instanceof Error ? err.message : 'could not parse Workast export'
    );
  }

  return collect(parsed).map(({ task, category }, index) => {
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(task)) {
      // Keys that map onto a canonical column are not duplicated into metadata,
      // except the ones mapping genuinely needs to read back.
      if ([
        'workast_task_id', 'title', 'category', 'status', 'assignees', 'waiting_on',
        'due_date',
      ].includes(key)) continue;
      metadata[key] = value;
    }
    // Mapping reads these two by name, so they must be present under these keys.
    if (task.due_time !== undefined) metadata.due_time = task.due_time;
    if (task.due_timezone !== undefined) metadata.due_timezone = task.due_timezone;
    metadata.waiting = task.waiting === true;
    if (Array.isArray(task.assignees)) metadata.assignees = task.assignees;

    return {
      rowNumber: index + 1,
      sourceType: 'workast',
      // Workast's own id is the strongest idempotency key available.
      sourceRecordId: orNull(task.workast_task_id),
      // Byte-exact, straight from the export.
      title: typeof task.title === 'string' ? task.title : '',
      space: category ?? orNull(task.category),
      listState: null,
      assignee: firstAssignee(task.assignees),
      dueAt: orNull(task.due_date),
      waitingOn: orNull(task.waiting_on),
      createdAt: null, // the export carries no creation timestamps
      completedAt: null,
      status: orNull(task.status),
      sourceMetadata: metadata,
    };
  });
};
