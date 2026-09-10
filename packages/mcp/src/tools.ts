import type { Db } from '@tr/db';
import {
  completeTask, createTask, getSpaceForChannel, getTask, getTaskCounts,
  listSpaces, listTasks, listWaiting, moveTask, resolveDestinationSpace,
  updateTaskDetails, TaskNotFoundError, type TaskStatus,
  openCountBySpace, completedBetween, createdThisWeek, completedThisWeek,
  averageTaskAgeDays, staleTasks,
} from '@tr/task-core';
import {
  listBatches, getBatch, getStagedRows, getConflicts, getAudit, verdictCounts,
} from '@tr/importer';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const HERMES = { id: null, source: 'hermes-mcp' };

export function buildTools(db: Db): McpTool[] {
  return [
    {
      name: 'list_tasks',
      description:
        'List tasks with exact titles. Set actionable_only to exclude waiting and completed tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          space_id: { type: 'string' },
          assignee_id: { type: 'string' },
          status: { type: 'string', enum: ['open', 'waiting', 'completed'] },
          actionable_only: { type: 'boolean' },
          limit: { type: 'number' },
        },
      },
      handler: async (a) => ({
        tasks: await listTasks(db, {
          spaceId: str(a.space_id),
          assigneeId: str(a.assignee_id),
          status: str(a.status) as TaskStatus | undefined,
          actionableOnly: a.actionable_only === true,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
        }),
      }),
    },
    {
      name: 'get_task',
      description: 'Get one task by id, with its exact title.',
      inputSchema: {
        type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'],
      },
      handler: async (a) => {
        const task = await getTask(db, String(a.task_id));
        if (!task) throw new TaskNotFoundError(String(a.task_id));
        return { task };
      },
    },
    {
      name: 'create_task',
      description:
        'Create a task. The title is stored exactly as given and can never be changed ' +
        'afterwards. Do not summarize, rewrite, combine, or split what the user said — ' +
        'pass their words through verbatim.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The literal task title, verbatim.' },
          space_id: { type: 'string' },
          assignee_id: { type: 'string' },
          due_at: { type: 'string', description: 'ISO 8601 timestamp' },
          details: {
            type: 'string',
            description:
              'Optional capture notes stored alongside the task. Write-once — there ' +
              'is no way to change it afterwards.',
          },
        },
        required: ['title', 'space_id'],
      },
      handler: async (a) => {
        const title = str(a.title);
        const spaceId = str(a.space_id);
        if (!title) throw new Error('title must be a non-empty string');
        if (!spaceId) throw new Error('space_id must be a string');
        return {
          task: await createTask(db, {
            title, spaceId,
            assigneeId: str(a.assignee_id) ?? null,
            dueAt: str(a.due_at) ? new Date(String(a.due_at)) : null,
            sourcePlatform: 'hermes',
            createdBy: str(a.created_by) ?? null,
            details: str(a.details) ?? null,
          }),
        };
      },
    },
    {
      name: 'complete_task',
      description: 'Mark a task completed. Idempotent. Requires explicit user authorization.',
      inputSchema: {
        type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'],
      },
      handler: async (a) => ({ task: await completeTask(db, String(a.task_id), HERMES) }),
    },
    {
      name: 'move_task',
      description:
        'Change a task space, status, or waiting_on. Cannot change the title — any title ' +
        'field is ignored. Requires explicit user instruction.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          space_id: { type: 'string' },
          status: { type: 'string', enum: ['open', 'waiting', 'completed'] },
          waiting_on: { type: 'string' },
        },
        required: ['task_id'],
      },
      handler: async (a) => ({
        task: await moveTask(db, String(a.task_id), {
          spaceId: str(a.space_id),
          status: str(a.status) as TaskStatus | undefined,
          waitingOn: str(a.waiting_on),
        }, HERMES),
      }),
    },
    {
      name: 'set_task_details',
      description:
        'Replace a task\'s details (its notes). Cannot change the title — this tool ' +
        'reads only task_id and details. Pass null to clear. Requires explicit user ' +
        'instruction; do not rewrite a user\'s notes unasked.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          details: { type: ['string', 'null'] },
        },
        required: ['task_id', 'details'],
      },
      handler: async (a) => ({
        task: await updateTaskDetails(
          db, String(a.task_id),
          a.details === null ? null : (str(a.details) ?? null),
          HERMES
        ),
      }),
    },
    {
      name: 'list_spaces',
      description: 'List all Spaces. Space names are deterministic configuration data.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ spaces: await listSpaces(db) }),
    },
    {
      name: 'list_waiting',
      description: 'List waiting/blocked tasks. These are not normal actionable tasks.',
      inputSchema: { type: 'object', properties: { space_id: { type: 'string' } } },
      handler: async (a) => ({ tasks: await listWaiting(db, { spaceId: str(a.space_id) }) }),
    },
    {
      name: 'get_space_for_channel',
      description:
        'Resolve a Slack channel ID to its canonical Space using the deterministic ' +
        'configuration mapping. Returns mapped:false and the Inbox Space when the ' +
        'channel has no mapping. Never infers a client from channel text.',
      inputSchema: {
        type: 'object',
        properties: { channel_id: { type: 'string' } },
        required: ['channel_id'],
      },
      handler: async (a) => {
        const r = await getSpaceForChannel(db, str(a.channel_id) ?? null);
        return { space: r.space, mapped: r.mapped, channel_name: r.channelName };
      },
    },
    {
      name: 'list_tasks_for_context',
      description:
        'List tasks for the Space that a Slack channel maps to — use this when the ' +
        'user asks "show my tasks" or "what is open?" from a channel. Pass the ' +
        'channel_id and nothing else; you do not need to know Space IDs. Optionally ' +
        'pass space to look at a different Space instead. Excludes waiting and ' +
        'completed tasks unless include_waiting or status says otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          space: { type: 'string', description: 'Optional explicit Space, overriding the channel mapping.' },
          include_waiting: { type: 'boolean' },
          status: { type: 'string', enum: ['open', 'waiting', 'completed'] },
          limit: { type: 'number' },
        },
        required: ['channel_id'],
      },
      handler: async (a) => {
        const dest = await resolveDestinationSpace(db, {
          channelId: str(a.channel_id) ?? null,
          space: str(a.space) ?? null,
        });
        const status = str(a.status) as TaskStatus | undefined;
        const tasks = await listTasks(db, {
          spaceId: dest.space.id,
          status: status ?? (a.include_waiting === true ? ['open', 'waiting'] : undefined),
          actionableOnly: !status && a.include_waiting !== true,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
        });
        return { space: dest.space, resolved_from: dest.source, tasks };
      },
    },
    {
      name: 'create_task_for_context',
      description:
        'Create a task in the Space that a Slack channel maps to — use this when the ' +
        'user asks to add a task from a channel. The title is stored exactly as given ' +
        'and can never be changed afterwards: pass their words through verbatim, do ' +
        'not summarize or rewrite. Pass space only when the user names an explicit ' +
        'destination; an explicit space overrides the channel mapping, and an ' +
        'unrecognised one is rejected rather than guessed at.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          title: { type: 'string', description: 'The literal task title, verbatim.' },
          space: { type: 'string', description: 'Optional explicit destination Space.' },
          due_at: { type: 'string', description: 'ISO 8601 timestamp' },
          assignee_id: { type: 'string' },
          details: { type: 'string', description: 'Optional capture notes. Write-once.' },
        },
        required: ['channel_id', 'title'],
      },
      handler: async (a) => {
        const title = str(a.title);
        if (!title) throw new Error('title must be a non-empty string');
        const dest = await resolveDestinationSpace(db, {
          channelId: str(a.channel_id) ?? null,
          space: str(a.space) ?? null,
        });
        const task = await createTask(db, {
          title,
          spaceId: dest.space.id,
          assigneeId: str(a.assignee_id) ?? null,
          dueAt: str(a.due_at) ? new Date(String(a.due_at)) : null,
          sourcePlatform: 'hermes',
          sourceChannelId: str(a.channel_id) ?? null,
          details: str(a.details) ?? null,
        });
        return { task, space: dest.space, resolved_from: dest.source };
      },
    },
    // --- Import inspection. All four are READS. Hermes may look and explain;
    // it may not confirm, import, roll back, or merge anything.
    {
      name: 'list_import_batches',
      description:
        'List import batches, newest first, with their state and row counts. ' +
        'Read-only.',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      handler: async (a) => ({
        batches: await listBatches(db, typeof a.limit === 'number' ? a.limit : 20),
      }),
    },
    {
      name: 'get_import_batch',
      description:
        'Get one import batch with its mapping, counts, and audit summary. ' +
        'Read-only.',
      inputSchema: {
        type: 'object', properties: { batch_id: { type: 'string' } },
        required: ['batch_id'],
      },
      handler: async (a) => {
        const batch = await getBatch(db, String(a.batch_id));
        if (!batch) throw new Error(`no import batch ${String(a.batch_id)}`);
        return {
          batch,
          counts: await verdictCounts(db, batch.id),
          audit: await getAudit(db, batch.id),
        };
      },
    },
    {
      name: 'preview_import',
      description:
        'Show the staged rows of an existing import batch and the verdict each ' +
        'was given. Takes a batch_id, NOT a file: parsing and staging happen ' +
        'through the CLI or the Slack wizard, never here. Read-only, and it ' +
        'cannot cause an import.',
      inputSchema: {
        type: 'object',
        properties: {
          batch_id: { type: 'string' },
          verdict: {
            type: 'string',
            enum: ['READY', 'SKIP_DUPLICATE', 'NEEDS_REVIEW', 'INVALID'],
          },
        },
        required: ['batch_id'],
      },
      handler: async (a) => ({
        rows: await getStagedRows(
          db, String(a.batch_id),
          (str(a.verdict) as 'READY' | undefined) ?? undefined
        ),
        counts: await verdictCounts(db, String(a.batch_id)),
      }),
    },
    {
      name: 'get_import_conflicts',
      description:
        'The rows of an import batch that need a human decision: NEEDS_REVIEW ' +
        'and INVALID, each with its reason and any conflicting task. Explain ' +
        'these to the user and suggest mappings; do not resolve them yourself.',
      inputSchema: {
        type: 'object', properties: { batch_id: { type: 'string' } },
        required: ['batch_id'],
      },
      handler: async (a) => ({
        conflicts: await getConflicts(db, String(a.batch_id)),
      }),
    },
    // --- Reporting. All reads.
    {
      name: 'get_open_counts_by_space',
      description: 'Open task count per Space. Excludes waiting and completed.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ counts: await openCountBySpace(db) }),
    },
    {
      name: 'get_completed_between',
      description:
        'Tasks completed in a date range. `from` is inclusive, `to` exclusive, ' +
        'so abutting ranges never double-count.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'ISO 8601' },
          to: { type: 'string', description: 'ISO 8601' },
          space_id: { type: 'string' },
        },
        required: ['from', 'to'],
      },
      handler: async (a) => ({
        tasks: await completedBetween(
          db, new Date(String(a.from)), new Date(String(a.to)),
          { spaceId: str(a.space_id) }
        ),
      }),
    },
    {
      name: 'get_this_week',
      description:
        'Tasks created and completed so far this week. The week starts Monday ' +
        '00:00 UTC.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        created: await createdThisWeek(db),
        completed: await completedThisWeek(db),
      }),
    },
    {
      name: 'get_task_health',
      description:
        'Mean age in days of open tasks, and the open tasks older than a ' +
        'threshold. Waiting tasks are excluded from both: they are parked on ' +
        'purpose, so counting them as stale would bury genuine neglect.',
      inputSchema: {
        type: 'object',
        properties: {
          stale_after_days: { type: 'number' },
          space_id: { type: 'string' },
        },
      },
      handler: async (a) => ({
        average_age_days: await averageTaskAgeDays(db, { spaceId: str(a.space_id) }),
        stale: await staleTasks(
          db,
          typeof a.stale_after_days === 'number' ? a.stale_after_days : 30,
          { spaceId: str(a.space_id) }
        ),
      }),
    },
    {
      name: 'get_task_counts',
      description: 'Per-space open and waiting counts. Completed tasks are excluded.',
      inputSchema: { type: 'object', properties: { assignee_id: { type: 'string' } } },
      handler: async (a) => ({ counts: await getTaskCounts(db, { assigneeId: str(a.assignee_id) }) }),
    },
  ];
}

export const TOOL_NAMES: string[] = [
  'list_tasks', 'get_task', 'create_task', 'complete_task', 'move_task',
  'list_spaces', 'list_waiting', 'set_task_details',
  'get_space_for_channel', 'list_tasks_for_context', 'create_task_for_context',
  'get_task_counts',
  // Import inspection, all reads.
  'list_import_batches', 'get_import_batch', 'preview_import',
  'get_import_conflicts',
  // Reporting, all reads.
  'get_open_counts_by_space', 'get_completed_between', 'get_this_week',
  'get_task_health',
];
