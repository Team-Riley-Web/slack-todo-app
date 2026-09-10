import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '@tr/db';
import {
  completeTask, createTask, getSpaceForChannel, getTask, getTaskCounts,
  listChannelMap, listSpaces, listTasks, listWaiting, moveTask, reopenTask,
  updateTaskDetails,
  resolveDestinationSpace,
  InvalidDueDateError, InvalidTaskIdError, TaskNotFoundError, UnknownSpaceError,
  type TaskStatus,
} from '@tr/task-core';

export interface ApiDeps { db: Db; apiToken: string | null }

/** Constant-time, matching the Slack signature path rather than `!==`. */
function tokenMatches(header: string, apiToken: string): boolean {
  const expected = Buffer.from(`Bearer ${apiToken}`, 'utf8');
  const given = Buffer.from(header, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { db } = deps;

  app.addHook('onRequest', async (req, reply) => {
    if (!deps.apiToken) {
      return reply.code(503).send({ error: 'API_TOKEN not configured' });
    }
    if (!tokenMatches(req.headers.authorization ?? '', deps.apiToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof InvalidTaskIdError) return reply.code(400).send({ error: 'invalid_task_id' });
    if (err instanceof InvalidDueDateError) return reply.code(400).send({ error: 'invalid_due_at' });
    if (err instanceof TaskNotFoundError) return reply.code(404).send({ error: 'task_not_found' });
    if (err instanceof UnknownSpaceError) {
      return reply.code(400).send({
        error: 'unknown_space', requested: err.requested, available: err.available,
      });
    }
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

  app.get('/channel-map', async () => ({ channels: await listChannelMap(db) }));

  /**
   * Channel-aware context routes. Hermes passes a Slack channel ID and never
   * needs to know internal Space IDs; the service resolves
   * channel -> canonical Space -> exact task operation.
   */
  app.get('/context/:channelId/space', async (req) => {
    const { channelId } = req.params as { channelId: string };
    const r = await getSpaceForChannel(db, channelId);
    return { space: r.space, mapped: r.mapped, channel_name: r.channelName };
  });

  app.get('/context/:channelId/tasks', async (req) => {
    const { channelId } = req.params as { channelId: string };
    const q = req.query as Record<string, string | undefined>;
    const dest = await resolveDestinationSpace(db, { channelId, space: q.space ?? null });
    const status = q.status as TaskStatus | undefined;
    const includeWaiting = q.include_waiting === 'true';
    return {
      space: dest.space,
      resolved_from: dest.source,
      tasks: await listTasks(db, {
        spaceId: dest.space.id,
        status: status ?? (includeWaiting ? ['open', 'waiting'] : undefined),
        actionableOnly: !status && !includeWaiting,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });

  app.post('/context/:channelId/tasks', async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.title !== 'string' || b.title.length === 0) {
      return reply.code(400).send({ error: 'title_required' });
    }
    const dest = await resolveDestinationSpace(db, {
      channelId,
      space: typeof b.space === 'string' ? b.space : null,
    });
    const task = await createTask(db, {
      title: b.title,
      spaceId: dest.space.id,
      assigneeId: typeof b.assignee_id === 'string' ? b.assignee_id : null,
      dueAt: typeof b.due_at === 'string' ? new Date(b.due_at) : null,
      sourcePlatform: typeof b.source_platform === 'string' ? b.source_platform : 'api',
      sourceChannelId: channelId,
      createdBy: typeof b.created_by === 'string' ? b.created_by : null,
      details: typeof b.details === 'string' ? b.details : null,
    });
    return reply.code(201).send({ task, space: dest.space, resolved_from: dest.source });
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
      details: typeof b.details === 'string' ? b.details : null,
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

  /** Updates only details. There is still no route that can change a title. */
  app.post('/tasks/:id/details', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.details !== null && typeof b.details !== 'string') {
      return reply.code(400).send({ error: 'details_must_be_string_or_null' });
    }
    return { task: await updateTaskDetails(db, id, b.details as string | null, actor(req as never)) };
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
