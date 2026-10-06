import {
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Db } from '@tr/db';
import { createMcpServer } from './server.js';
import { TOOL_NAMES } from './tools.js';
import {
  authorizeOAuthAccess, isOAuthConfigured, resourceMetadataUrl, type OAuthDeps,
} from './oauth.js';

/**
 * Remote MCP over authenticated HTTPS.
 *
 * The transport is the SDK's own Streamable HTTP implementation in STATELESS
 * mode (`sessionIdGenerator: undefined`), which is the documented shape for a
 * serverless host: a fresh server and transport per request, nothing retained
 * between them, no session affinity required. That matters because the only
 * deployed surface this system has is the Vercel app -- a session-bearing
 * transport would need a long-lived process, and emulating one on serverless
 * is exactly the workaround not to build.
 *
 * The tools come from `createMcpServer`, the same function the stdio server
 * calls, so the two transports cannot expose different contracts.
 */

/** Set when the endpoint is usable at all. Never the value, only that it exists. */
export function isMcpHttpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TASKS_MCP_TOKEN?.trim().length ?? 0) > 0;
}

/**
 * Constant-time bearer check.
 *
 * Length first so a wrong-length guess cannot be timed, then every character
 * compared rather than bailing at the first mismatch. An unset token denies
 * everything: a deployment that forgot to configure it must be closed, not open.
 *
 * Separate from the REST API's `API_TOKEN` on purpose — Hermes's MCP access can
 * then be revoked without taking the REST API down with it.
 */
export function authorizeMcpRequest(
  authorization: string | null, env: NodeJS.ProcessEnv = process.env
): boolean {
  const secret = env.TASKS_MCP_TOKEN?.trim();
  if (!secret) return false;
  const offered = (authorization ?? '').replace(/^Bearer\s+/i, '');
  if (offered.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i += 1) {
    diff |= secret.charCodeAt(i) ^ offered.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 401 with nothing in it.
 *
 * No hint about whether the token was absent, the wrong length, or merely
 * wrong, and no echo of what was sent -- an error message is a place
 * credentials leak into logs.
 */
function unauthorized(discovery?: string): Response {
  return new Response(
    JSON.stringify({ error: 'unauthorized' }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        // The metadata URL is what lets a connector find the sign-in flow
        // (RFC 9728). It is a public address, not a credential.
        'www-authenticate': 'Bearer realm="team-riley-tasks-mcp"' +
          (discovery ? `, resource_metadata="${discovery}"` : ''),
      },
    }
  );
}

export interface McpHttpOptions {
  getDb: () => Promise<Db>;
  env?: NodeJS.ProcessEnv;
  /**
   * Allowlist check for OAuth access tokens. Supplying it is what turns the
   * connector sign-in on; without it only the static Hermes token is accepted.
   */
  isAllowed?: OAuthDeps['isAllowed'];
  now?: () => number;
}

/** One remote MCP request: authorize, then hand it to the SDK transport. */
export async function handleMcpHttpRequest(
  request: Request, opts: McpHttpOptions
): Promise<Response> {
  const env = opts.env ?? process.env;
  const oauthOn = opts.isAllowed !== undefined && isOAuthConfigured(env);
  // Two credentials, one tool list: the static token (Hermes) or a signed
  // OAuth access token (Claude / ChatGPT connectors). Either way nothing below
  // this check can tell which one it was.
  const ok = authorizeMcpRequest(request.headers.get('authorization'), env) ||
    (oauthOn && authorizeOAuthAccess(request, { env, now: opts.now, isAllowed: opts.isAllowed! }) !== null);
  if (!ok) {
    return unauthorized(oauthOn ? resourceMetadataUrl(new URL(request.url).origin) : undefined);
  }

  // Built only after the request is authorized, so an unauthenticated caller
  // never causes a database connection.
  const db = await opts.getDb();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    /*
     * Answer with a complete JSON body rather than opening an SSE stream.
     *
     * A serverless invocation ends when it returns its response, so a stream
     * it is supposed to keep feeding is a stream nobody can serve -- the first
     * version of this returned 200 with `content-type: text/event-stream` and
     * an EMPTY body, because the function had already finished. JSON responses
     * are a supported part of Streamable HTTP, not a workaround, and they suit
     * a request/response host exactly.
     */
    enableJsonResponse: true,
  });
  const server = createMcpServer(db);
  await server.connect(transport);

  try {
    return await transport.handleRequest(request);
  } finally {
    /*
     * Per-request server and transport; nothing may outlive the response.
     * Safe here ONLY because enableJsonResponse means the body is already
     * complete when handleRequest resolves -- closing an SSE stream at this
     * point would truncate it before the client read a byte.
     */
    await transport.close().catch(() => {});
  }
}

/**
 * Liveness, without authentication and without anything worth protecting.
 *
 * Reports that the service is up, which contract it serves, and whether a
 * token has been configured -- never the token, never a task, never a count of
 * anything real. `tools` is the tool NAME count, which is already public in
 * MCP_CONTRACT.md.
 */
export function mcpHealth(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean; service: string; transport: string; tools: number; configured: boolean;
  oauth: boolean;
} {
  const configured = isMcpHttpConfigured(env);
  return {
    ok: configured,
    service: 'team-riley-tasks-mcp',
    transport: 'streamable-http',
    tools: TOOL_NAMES.length,
    configured,
    // That connector sign-in has a secret to sign with; never the secret.
    oauth: isOAuthConfigured(env),
  };
}
