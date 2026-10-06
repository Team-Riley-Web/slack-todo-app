import { handleMcpHttpRequest } from '@tr/mcp/http';
import { getDb } from '@/db';
import { oauthDeps } from '@/lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Remote MCP for Hermes: `https://<host>/mcp`.
 *
 * A thin adapter, like the Slack receiver next door. Authentication and every
 * tool live in `@tr/mcp`, so nothing under `src/app` reads a credential —
 * `src/no-secrets.test.ts` enforces that.
 *
 * Mounted here rather than in `apps/api` for a plain reason: `apps/api` has no
 * deployment of any kind (no Dockerfile, no platform config — it runs locally
 * on :3030), so an endpoint there would have no public host for Hermes to
 * reach. This app is the only deployed surface, and it already terminates
 * HTTPS and holds the database URL.
 *
 * Two credentials are accepted: the static Hermes token, or an OAuth access
 * token from a Claude / ChatGPT connector sign-in (docs/specs/connector-oauth.md).
 *
 * POST carries every MCP request. GET is the protocol's SSE upgrade, which
 * stateless mode does not serve; the SDK answers it correctly on its own.
 */
function handle(request: Request): Promise<Response> {
  return handleMcpHttpRequest(request, { getDb, isAllowed: oauthDeps.isAllowed });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
