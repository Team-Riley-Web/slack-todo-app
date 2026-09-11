import { App as BoltApp, type Receiver, type ReceiverEvent } from '@slack/bolt';
import { createDb, type Db } from '@tr/db';
import { registerSlackHandlers } from './app.js';
import { loadConfig } from './config.js';
import { pruneProcessedInteractions, retentionDays } from './retention.js';
import { verifySlackSignature } from './signature.js';

export const SLACK_HTTP_REQUIRED_ENV = [
  'DATABASE_URL',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_TEAM_ID',
  'AUTHORIZED_SLACK_USER_IDS',
] as const;

export function missingSlackHttpEnv(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return SLACK_HTTP_REQUIRED_ENV.filter((name) => !env[name]?.trim());
}

/**
 * Defers the Postgres import and pool creation until a listener actually uses
 * the database. A cold Vercel invocation can therefore acknowledge a command
 * before loading a database driver or opening a network connection.
 */
export function createLazyDb(connect: () => Promise<Db> = () => createDb()): Db {
  let connection: Promise<Db> | null = null;
  const get = (): Promise<Db> => connection ??= connect();

  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return (await get()).query<T>(sql, params);
    },
    async exec(sql: string) {
      return (await get()).exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return (await get()).transaction(fn);
    },
    async close() {
      if (connection) await (await connection).close();
    },
  };
}

interface SlackEventProcessor {
  processEvent(event: ReceiverEvent): Promise<void>;
}

/** Bolt receiver with no server of its own; a Vercel Route Handler feeds it. */
class DeferredHttpReceiver implements Receiver, SlackEventProcessor {
  private app: BoltApp | null = null;

  init(app: BoltApp): void {
    this.app = app;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  processEvent(event: ReceiverEvent): Promise<void> {
    if (!this.app) throw new Error('Slack HTTP receiver was not initialized');
    return this.app.processEvent(event);
  }
}

export type DeferSlackWork = (work: Promise<void>) => void;

export interface SlackHttpRequestOptions {
  processor: SlackEventProcessor;
  signingSecret: string;
  defer: DeferSlackWork;
  ackTimeoutMs?: number;
  nowSeconds?: number;
  logError?: (message: string, error?: unknown) => void;
}

function parseSlackBody(rawBody: string, contentType: string): Record<string, any> {
  if (contentType.includes('application/json')) {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Slack JSON body must be an object');
    }
    return parsed as Record<string, any>;
  }

  if (!contentType.includes('application/x-www-form-urlencoded')) {
    throw new Error('Unsupported Slack request content type');
  }

  const form = new URLSearchParams(rawBody);
  const payload = form.get('payload');
  if (payload !== null) {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Slack interaction payload must be an object');
    }
    return parsed as Record<string, any>;
  }
  return Object.fromEntries(form.entries());
}

function ackResponse(body: unknown): Response {
  if (body === undefined) {
    return new Response(null, { status: 200 });
  }
  if (typeof body === 'string') {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return Response.json(body, { status: 200 });
}

/**
 * Verifies and dispatches one Slack HTTP delivery.
 *
 * `ack()` resolves the HTTP response independently of the listener promise.
 * Vercel's `after()` owns that promise, so work after an immediate ack is not
 * frozen when the response is sent.
 */
export async function handleSlackHttpRequest(
  request: Request,
  {
    processor,
    signingSecret,
    defer,
    ackTimeoutMs = 2_500,
    nowSeconds,
    logError = (message, error) => console.error(message, error),
  }: SlackHttpRequestOptions
): Promise<Response> {
  const rawBody = await request.text();
  const timestamp = Number(request.headers.get('x-slack-request-timestamp'));
  const signature = request.headers.get('x-slack-signature') ?? '';

  if (!verifySlackSignature({
    signingSecret,
    requestSignature: signature,
    requestTimestamp: timestamp,
    body: rawBody,
    nowSeconds,
  })) {
    return new Response('Invalid Slack signature', { status: 401 });
  }

  let body: Record<string, any>;
  try {
    body = parseSlackBody(rawBody, request.headers.get('content-type') ?? '');
  } catch (error) {
    logError('[slack-http] could not parse signed request', error);
    return new Response('Invalid Slack request', { status: 400 });
  }

  // Slack uses this when validating some HTTP request URLs.
  if (body.ssl_check) return new Response(null, { status: 200 });
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return Response.json({ challenge: body.challenge });
  }

  let acknowledged = false;
  let settled = false;
  let settle!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { settle = resolve; });
  const finish = (value: Response): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    settle(value);
  };
  const timeout = setTimeout(() => {
    logError('[slack-http] request was not acknowledged before the deadline');
    finish(new Response('Slack request was not acknowledged', { status: 500 }));
  }, ackTimeoutMs);

  const work = processor.processEvent({
    body,
    retryNum: Number(request.headers.get('x-slack-retry-num')) || undefined,
    retryReason: request.headers.get('x-slack-retry-reason') ?? undefined,
    ack: async (value?: unknown) => {
      if (acknowledged) throw new Error('Slack request was acknowledged more than once');
      acknowledged = true;
      if (settled) throw new Error('Slack request was acknowledged after the deadline');
      finish(ackResponse(value));
    },
  }).catch((error) => {
    logError('[slack-http] Bolt failed to process a request', error);
    if (!acknowledged) {
      finish(new Response('Slack request failed', { status: 500 }));
    }
  });

  try {
    defer(work);
  } catch (error) {
    logError('[slack-http] could not defer post-response work', error);
    finish(new Response('Slack request failed', { status: 500 }));
  }

  return response;
}

export interface CreateSlackHttpHandlerOptions {
  env?: NodeJS.ProcessEnv;
  connect?: () => Promise<Db>;
  ackTimeoutMs?: number;
}

export type SlackHttpHandler = (
  request: Request,
  defer: DeferSlackWork
) => Promise<Response>;

/** Builds one reusable Bolt app per warm Vercel function instance. */
export function createSlackHttpHandler({
  env = process.env,
  connect = () => createDb(),
  ackTimeoutMs,
}: CreateSlackHttpHandlerOptions = {}): SlackHttpHandler {
  const missing = missingSlackHttpEnv(env);
  if (missing.length > 0) {
    throw new Error(`Missing Slack HTTP environment: ${missing.join(', ')}`);
  }

  const receiver = new DeferredHttpReceiver();
  const config = { ...loadConfig(env), mode: 'http' as const };
  const db = createLazyDb(connect);
  const app = new BoltApp({
    receiver,
    // Supplying a token makes Bolt call auth.test before listener middleware,
    // which spends Slack's three-second ack budget on a network round-trip.
    // This single-workspace app already validates team_id in its own auth gate,
    // so return the configured token without a preflight request.
    authorize: async ({ teamId, enterpriseId }) => ({
      botToken: env.SLACK_BOT_TOKEN!,
      teamId,
      enterpriseId,
    }),
  });
  registerSlackHandlers(app, { db, config, env });

  // A serverless function has no durable process in which to run the local
  // twelve-hour retention timer. Run the same housekeeping once per warm
  // instance, after the first listener finishes, and retry on a later request
  // if the cleanup fails.
  let retentionState: 'pending' | 'running' | 'complete' = 'pending';

  return (request, defer) => handleSlackHttpRequest(request, {
    processor: receiver,
    signingSecret: env.SLACK_SIGNING_SECRET!,
    defer: (work) => {
      if (retentionState !== 'pending') {
        defer(work);
        return;
      }

      retentionState = 'running';
      defer(work.then(async () => {
        try {
          const removed = await pruneProcessedInteractions(db, retentionDays(env));
          retentionState = 'complete';
          if (removed > 0) {
            console.log(`[retention] pruned ${removed} processed interactions`);
          }
        } catch (error) {
          retentionState = 'pending';
          console.error('[retention] serverless sweep failed', error);
        }
      }));
    },
    ackTimeoutMs,
  });
}
