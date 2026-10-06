import { handleRegister } from '@tr/mcp/oauth';
import { oauthDeps } from '@/lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Dynamic client registration. Thin adapter; the rules live in `@tr/mcp`. */
export const POST = (request: Request): Promise<Response> => handleRegister(request, oauthDeps);
