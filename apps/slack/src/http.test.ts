import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@tr/db';
import type { ReceiverEvent } from '@slack/bolt';
import {
  createLazyDb,
  handleSlackHttpRequest,
  missingSlackHttpEnv,
} from './http.js';

const SECRET = 'test-signing-secret';
const NOW = 1_800_000_000;

function signedRequest(
  body: string,
  contentType = 'application/x-www-form-urlencoded',
  timestamp = NOW
): Request {
  const signature = `v0=${createHmac('sha256', SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
  return new Request('https://tasks.example/api/slack/events', {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': signature,
    },
    body,
  });
}

function processor(
  fn: (event: ReceiverEvent) => Promise<void>
): { processEvent: (event: ReceiverEvent) => Promise<void> } {
  return { processEvent: fn };
}

describe('Vercel Slack HTTP receiver', () => {
  it('returns the ack before deferred listener work finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let deferred: Promise<void> | undefined;
    let received: ReceiverEvent | undefined;
    const request = signedRequest(new URLSearchParams({
      command: '/task',
      text: 'Call Andre',
      team_id: 'T1',
      channel_id: 'C1',
      user_id: 'U1',
    }).toString());

    const response = await handleSlackHttpRequest(request, {
      signingSecret: SECRET,
      nowSeconds: NOW,
      processor: processor(async (event) => {
        received = event;
        await event.ack();
        await gate;
      }),
      defer: (work) => { deferred = work; },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(received?.body).toMatchObject({ command: '/task', text: 'Call Andre' });
    expect(deferred).toBeInstanceOf(Promise);
    release();
    await deferred;
  });

  it('parses interaction payloads and returns a JSON modal acknowledgement', async () => {
    const body = new URLSearchParams({
      payload: JSON.stringify({ type: 'view_submission', view: { callback_id: 'edit' } }),
    }).toString();
    const response = await handleSlackHttpRequest(signedRequest(body), {
      signingSecret: SECRET,
      nowSeconds: NOW,
      processor: processor(async (event) => {
        expect(event.body).toMatchObject({ type: 'view_submission' });
        await event.ack({ response_action: 'errors', errors: { title: 'Required' } });
      }),
      defer: () => {},
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      response_action: 'errors',
      errors: { title: 'Required' },
    });
  });

  it('rejects an invalid signature without dispatching the request', async () => {
    const processEvent = vi.fn();
    const request = new Request('https://tasks.example/api/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(NOW),
        'x-slack-signature': 'v0=wrong',
      },
      body: 'command=%2Ftask&text=Nope',
    });

    const response = await handleSlackHttpRequest(request, {
      signingSecret: SECRET,
      nowSeconds: NOW,
      processor: { processEvent },
      defer: () => {},
    });

    expect(response.status).toBe(401);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('rejects a correctly signed replay outside Slack\'s five-minute window', async () => {
    const processEvent = vi.fn();
    const response = await handleSlackHttpRequest(
      signedRequest('command=%2Ftask', undefined, NOW - 301),
      {
        signingSecret: SECRET,
        nowSeconds: NOW,
        processor: { processEvent },
        defer: () => {},
      }
    );

    expect(response.status).toBe(401);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('answers Slack URL validation without dispatching an event', async () => {
    const processEvent = vi.fn();
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const response = await handleSlackHttpRequest(
      signedRequest(body, 'application/json'),
      {
        signingSecret: SECRET,
        nowSeconds: NOW,
        processor: { processEvent },
        defer: () => {},
      }
    );

    expect(await response.json()).toEqual({ challenge: 'abc123' });
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('fails before Slack\'s deadline when a listener never acknowledges', async () => {
    const errors: string[] = [];
    const response = await handleSlackHttpRequest(
      signedRequest('command=%2Funknown'),
      {
        signingSecret: SECRET,
        nowSeconds: NOW,
        ackTimeoutMs: 5,
        processor: processor(async () => {}),
        defer: () => {},
        logError: (message) => { errors.push(message); },
      }
    );

    expect(response.status).toBe(500);
    expect(errors).toEqual([
      '[slack-http] request was not acknowledged before the deadline',
    ]);
  });
});

describe('Vercel Slack HTTP setup', () => {
  it('names missing production settings without exposing values', () => {
    expect(missingSlackHttpEnv({
      DATABASE_URL: 'postgres://example',
      SLACK_BOT_TOKEN: 'xoxb-secret',
    })).toEqual([
      'SLACK_SIGNING_SECRET',
      'SLACK_TEAM_ID',
      'AUTHORIZED_SLACK_USER_IDS',
    ]);
  });

  it('does not create a database connection until the first query and reuses it', async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ ok: true }] })),
      exec: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as Db;
    const connect = vi.fn(async () => db);
    const lazy = createLazyDb(connect);

    expect(connect).not.toHaveBeenCalled();
    await lazy.query('SELECT 1');
    await lazy.query('SELECT 2');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});
