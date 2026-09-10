import type { Db } from '@tr/db';
import {
  completeTask, createTask, getTask, getTaskCounts, listSpaces, listTasks,
  listWaiting, moveTask, TaskNotFoundError, type TaskStatus,
} from '@tr/task-core';

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
      name: 'get_task_counts',
      description: 'Per-space open and waiting counts. Completed tasks are excluded.',
      inputSchema: { type: 'object', properties: { assignee_id: { type: 'string' } } },
      handler: async (a) => ({ counts: await getTaskCounts(db, { assigneeId: str(a.assignee_id) }) }),
    },
  ];
}

export const TOOL_NAMES: string[] = [
  'list_tasks', 'get_task', 'create_task', 'complete_task', 'move_task',
  'list_spaces', 'list_waiting', 'get_task_counts',
];
