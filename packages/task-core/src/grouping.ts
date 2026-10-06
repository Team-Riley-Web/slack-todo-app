import type { Db } from '@tr/db';
import { listTasks } from './queries.js';
import { listSpaces } from './spaces.js';
import type { Space, Task } from './types.js';

/**
 * The shape `/tasks all` builds and the Slack card renderer consumes.
 *
 * Declared here rather than imported from `@tr/slack-ui` because the dependency
 * runs the other way: slack-ui imports task-core. These are structurally
 * identical to `CardEntry` and `CardGroup`, so they assign to each other
 * without a cast.
 */
export interface TaskInSpace { task: Task; space: Space }
export interface TaskGroup { heading: string; entries: TaskInSpace[] }

export interface GroupedTasks {
  /** Every task, flat, in the order the groups present them. */
  entries: TaskInSpace[];
  /** The same tasks grouped by Space, in `listSpaces` order. */
  groups: TaskGroup[];
}

export type SpacePredicate = (space: Space) => boolean;

export interface GroupedTasksOptions {
  /** Restricts the result to Spaces this returns true for. Default: all. */
  spaceFilter?: SpacePredicate;
  /** Passed through to `listTasks`, which caps it at 500. */
  limit?: number;
}

/**
 * Every open task, grouped by Space -- the query behind `/tasks all`.
 *
 * Extracted from the Slack handler so the scheduled weekly briefings run the
 * SAME query and the SAME grouping rather than a parallel implementation that
 * can drift. `actionableOnly` means status = 'open': waiting and completed are
 * both excluded, which is the semantics every caller here wants.
 *
 * Grouping walks `listSpaces` order rather than the task order, so a Space
 * appears at most once and two runs a second apart produce the same layout.
 */
export async function listOpenTasksBySpace(
  db: Db, opts: GroupedTasksOptions = {}
): Promise<GroupedTasks> {
  const spaces = new Map((await listSpaces(db)).map((s: Space) => [s.id, s]));
  const tasks = await listTasks(db, { actionableOnly: true, limit: opts.limit });

  const keep = opts.spaceFilter ?? (() => true);
  const entries: TaskInSpace[] = [];
  const groups: TaskGroup[] = [];

  for (const space of spaces.values()) {
    if (!keep(space)) continue;
    const inSpace = tasks
      .filter((task) => task.space_id === space.id)
      .map((task) => ({ task, space }));
    if (inSpace.length === 0) continue;
    groups.push({ heading: space.name.toUpperCase(), entries: inSpace });
    entries.push(...inSpace);
  }

  return { entries, groups };
}

/** The seeded Personal Space. */
export const PERSONAL_SPACE_SLUG = 'personal';

/**
 * Matches a Space by slug OR by name, both case-insensitively, against a
 * configured list -- e.g. the Spaces the weekly briefings send to #agency-ops.
 *
 * Two keys rather than one because `setSpaceName` regenerates the slug on a
 * rename while `space_aliases` keeps the old name working. Checking both means
 * a renamed Space still lands in the same briefing instead of silently moving
 * to another channel's.
 */
export function matchesSpaceKeys(space: Space, keys: readonly string[]): boolean {
  const wanted = keys.map((k) => k.trim().toLowerCase()).filter(Boolean);
  return wanted.includes(space.slug.toLowerCase())
    || wanted.includes(space.name.toLowerCase());
}
