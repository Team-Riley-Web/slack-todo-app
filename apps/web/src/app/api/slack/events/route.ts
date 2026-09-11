import { after } from 'next/server';
import {
  createSlackHttpHandler,
  missingSlackHttpEnv,
  type SlackHttpHandler,
} from '@tr/slack-app/http';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

let handler: SlackHttpHandler | null = null;

function getHandler(): SlackHttpHandler {
  return handler ??= createSlackHttpHandler();
}

/** Vercel and people can check deployment health without a Slack signature. */
export function GET(): Response {
  const configured = missingSlackHttpEnv().length === 0;
  return Response.json(
    { ok: configured, service: 'slack-events' },
    { status: configured ? 200 : 503 }
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await getHandler()(request, (work) => {
      // Slack listeners continue after an immediate ack without holding the
      // HTTP response open or depending on an always-running process.
      after(async () => { await work; });
    });
  } catch (error) {
    console.error('[slack-http] endpoint initialization failed', error);
    return Response.json(
      { ok: false, error: 'Slack endpoint is not configured' },
      { status: 503 }
    );
  }
}
