import { handleCaptureRequest } from '@/capture/handler';
import { getDb } from '@/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Quick capture for an Apple Shortcut ("Hey Siri, add task"). A thin adapter:
 * the token check and everything else live in `src/capture/handler.ts`, so
 * nothing under `src/app` reads a credential (see no-secrets.test.ts).
 */
export function POST(request: Request): Promise<Response> {
  return handleCaptureRequest(request, { getDb });
}
