import { authorizationServerMetadata } from '@tr/mcp/oauth';

export const dynamic = 'force-dynamic';

/** RFC 8414 discovery for the connector sign-in. See docs/specs/connector-oauth.md. */
export function GET(request: Request): Response {
  return Response.json(authorizationServerMetadata(new URL(request.url).origin));
}
