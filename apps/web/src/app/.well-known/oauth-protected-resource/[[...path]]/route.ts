import { protectedResourceMetadata } from '@tr/mcp/oauth';

export const dynamic = 'force-dynamic';

/**
 * RFC 9728 discovery. A client given `https://<host>/mcp` asks for
 * `/.well-known/oauth-protected-resource/mcp` first and the bare path second,
 * so the optional catch-all answers both with the same document.
 */
export function GET(request: Request): Response {
  return Response.json(protectedResourceMetadata(new URL(request.url).origin));
}
