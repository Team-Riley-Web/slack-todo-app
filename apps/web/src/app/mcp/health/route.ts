import { mcpHealth } from '@tr/mcp/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness for the remote MCP endpoint.
 *
 * Its own path rather than a GET on `/mcp`, because GET there belongs to the
 * MCP protocol itself and overloading it would mean answering a protocol
 * request with a health document.
 *
 * Deliberately unauthenticated and deliberately boring: it touches no
 * database, exposes no task, and reports only that a token IS configured —
 * never what it is. 503 when unconfigured, so a deploy missing TASKS_MCP_TOKEN
 * is visible before Hermes tries to connect.
 */
export function GET(): Response {
  const health = mcpHealth();
  return Response.json(health, { status: health.ok ? 200 : 503 });
}
