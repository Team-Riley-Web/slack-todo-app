import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { listTasks } from '@tr/task-core';
import { authorizeCapture, handleCaptureRequest } from './handler.js';

let db: Db;
const env = {
  CAPTURE_TOKEN: 'siri-token-value', DEFAULT_TIMEZONE: 'America/Chicago',
  DEFAULT_ASSIGNEE_SLACK_ID: 'U_JOSH',
} as unknown as NodeJS.ProcessEnv;
const now = new Date('2026-10-14T14:07:00Z'); // 9:07am CDT

const post = (body: unknown, token = 'siri-token-value') =>
  handleCaptureRequest(
    new Request('https://x.test/api/capture', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { getDb: async () => db, env, now }
  );

beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

describe('authorization', () => {
  it('needs its own token, and denies everything when unset', async () => {
    expect(authorizeCapture('Bearer siri-token-value', env)).toBe(true);
    expect(authorizeCapture('Bearer wrong-token-value', env)).toBe(false);
    expect(authorizeCapture('Bearer anything', {} as never)).toBe(false);
    const res = await post({ text: 'Sneaky' }, 'nope');
    expect(res.status).toBe(401);
    expect(await listTasks(db)).toHaveLength(0);
  });
});

describe('capturing from a Shortcut', () => {
  it('files dictated text in Inbox, assigned to the default, and says so', async () => {
    const res = await post({ text: 'Call Neil about the renewal' });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('Added Call Neil about the renewal to Inbox.');
    const [task] = await listTasks(db);
    expect(task).toMatchObject({
      title: 'Call Neil about the renewal', assignee_id: 'U_JOSH', source_platform: 'siri',
    });
  });

  it('takes a due choice from the Shortcut menu, as the day, not this minute', async () => {
    const res = await post({ text: 'Send invoice', due: 'today' });
    expect(await res.text()).toBe('Added Send invoice to Inbox, due today.');
    expect((await listTasks(db))[0]!.due_at!.toISOString()).toBe('2026-10-14T05:00:00.000Z');
  });

  it('understands a spoken trailing "due tomorrow", but not a bare "tomorrow"', async () => {
    await post({ text: 'Book the venue due tomorrow.' });
    await post({ text: 'Plan for tomorrow' });
    const tasks = await listTasks(db);
    const venue = tasks.find((t) => t.title === 'Book the venue')!;
    expect(venue.due_at!.toISOString()).toBe('2026-10-15T05:00:00.000Z');
    expect(tasks.find((t) => t.title === 'Plan for tomorrow')!.due_at).toBeNull();
  });

  it('reads priority like Slack /task, and files into a named Space', async () => {
    const res = await post({ text: 'P1 Follow up on retainer', space: 'Sales' });
    expect(await res.text()).toBe('Added Follow up on retainer to Sales.');
    expect((await listTasks(db))[0]).toMatchObject({ priority: 'P1' });
  });

  it('accepts the bare text as the body', async () => {
    const res = await post('Water the plants');
    expect(res.status).toBe(201);
  });

  it('answers a sentence, not an error page, for nothing heard or an unknown Space', async () => {
    expect(await (await post({ text: '   ' })).text()).toBe('I did not catch a task. Try again.');
    const res = await post({ text: 'X', space: 'Nowhere' });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('There is no Space called Nowhere.');
    expect(await listTasks(db)).toHaveLength(0);
  });
});
