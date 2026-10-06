import { handleToken } from '@tr/mcp/oauth';
import { oauthDeps } from '@/lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Code and refresh-token exchange. Thin adapter; the rules live in `@tr/mcp`. */
export const POST = (request: Request): Promise<Response> => handleToken(request, oauthDeps);
