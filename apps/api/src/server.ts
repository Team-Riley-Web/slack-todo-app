import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '@tr/db';
import {
  completeTask, createTask, getTask, getTaskCounts, listSpaces, listTasks,
  listWaiting, moveTask, reopenTask,
  InvalidTaskIdError, TaskNotFoundError, type TaskStatus,
} from '@tr/task-core';

export interface ApiDeps { db: Db; apiToken: string | null }

export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { db } = deps;

  app.addHook('onRequest', async (req, reply) => {
    if (!deps.apiToken) {
      return reply.code(503).send({ error: 'API_TOKEN not configured' });
    }
    if ((req.headers.authorization ?? '') !== `Bearer ${deps.apiToken}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof InvalidTaskIdError) return reply.code(400).send({ error: 'invalid_task_id' });
    if (err instanceof TaskNotFoundError) return reply.code(404).send({ error: 'task_not_found' });
    return reply.code(500).send({ error: 'internal_error' });
  });

  const actor = (req: { headers: Record<string, unknown> }) => ({
    id: typeof req.headers['x-actor-id'] === 'string' ? (req.headers['x-actor-id'] as string) : null,
    source: 'api',
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/spaces', async () => ({ spaces: await listSpaces(db) }));

  app.get('/tasks', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return {
      tasks: await listTasks(db, {
        spaceId: q.space_id,
        assigneeId: q.assignee_id,
        actionableOnly: q.actionable === 'true',
        status: q.status as TaskStatus | undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });

  app.get('/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await getTask(db, id);
    if (!task) return reply.code(404).send({ error: 'task_not_found' });
    return { task };
  });

  app.get('/waiting', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { tasks: await listWaiting(db, { spaceId: q.space_id }) };
  });

  app.get('/counts', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { counts: await getTaskCounts(db, { assigneeId: q.assignee_id }) };
  });

  /**
   * The title is taken verbatim. There is deliberately no route, anywhere,
   * that can change a title once stored.
   */
  app.post('/tasks', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.title !== 'string' || b.title.length === 0) {
      return reply.code(400).send({ error: 'title_required' });
    }
    if (typeof b.space_id !== 'string') {
      return reply.code(400).send({ error: 'space_id_required' });
    }
    const task = await createTask(db, {
      title: b.title,
      spaceId: b.space_id,
      assigneeId: typeof b.assignee_id === 'string' ? b.assignee_id : null,
      dueAt: typeof b.due_at === 'string' ? new Date(b.due_at) : null,
      sourcePlatform: typeof b.source_platform === 'string' ? b.source_platform : 'api',
      createdBy: typeof b.created_by === 'string' ? b.created_by : null,
    });
    return reply.code(201).send({ task });
  });

  app.post('/tasks/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    return { task: await completeTask(db, id, actor(req as never)) };
  });

  app.post('/tasks/:id/reopen', async (req) => {
    const { id } = req.params as { id: string };
    return { task: await reopenTask(db, id, actor(req as never)) };
  });

  app.post('/tasks/:id/move', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    // Only these three keys are read. A `title` key is ignored.
    return {
      task: await moveTask(db, id, {
        spaceId: typeof b.space_id === 'string' ? b.space_id : undefined,
        status: typeof b.status === 'string' ? (b.status as TaskStatus) : undefined,
        waitingOn: typeof b.waiting_on === 'string' ? b.waiting_on : undefined,
      }, actor(req as never)),
    };
  });

  return app;
}
