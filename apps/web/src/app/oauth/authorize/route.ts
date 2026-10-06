import { handleAuthorize } from '@tr/mcp/oauth';
import { oauthDeps } from '@/lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Consent screen (GET) and decision (POST). A signed-out visitor is sent to
 * `/signin?next=…` and returns here after Slack. Thin adapter; the rules live
 * in `@tr/mcp`.
 */
const handle = (request: Request): Promise<Response> => handleAuthorize(request, oauthDeps);
export const GET = handle;
export const POST = handle;
