import { handleScheduledRequest } from '@tr/scheduler';
import { getDb } from '@/db';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * The weekly Slack task briefings, driven every Monday by Vercel Cron (see
 * vercel.json and SCHEDULED.md).
 *
 * A thin adapter on purpose. Everything that reads a credential or decides
 * what to post lives in `@tr/scheduler`, so nothing under `src/app` holds a
 * secret -- the same split the Slack events route makes, enforced by
 * `src/no-secrets.test.ts`.
 *
 * GET because that is what Vercel Cron issues; POST is accepted too, for
 * manual triggers from anything that dislikes a GET with side effects.
 */
function handle(request: Request): Promise<Response> {
  return handleScheduledRequest(request, { getDb });
}

export const GET = handle;
export const POST = handle;
