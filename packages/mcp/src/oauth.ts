import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * OAuth 2.1 for the remote MCP endpoint, so Claude.ai and ChatGPT custom
 * connectors can sign in. Spec: docs/specs/connector-oauth.md.
 *
 * STATELESS. The client id, the authorization request, the authorization code,
 * the access token and the refresh token are all HMAC-signed blobs keyed by
 * `MCP_OAUTH_SECRET`, carrying only what they need. Nothing is stored, so there
 * is no table to migrate and nothing to clean up. The costs, accepted on
 * purpose:
 *
 *  - A code cannot be marked single-use. PKCE binds it to the client that asked
 *    and the 60-second lifetime bounds the window.
 *  - Revocation is by allowlist, not by token: every request re-checks the Slack
 *    user id (`isAllowed`), so removing someone from AUTHORIZED_SLACK_USER_IDS
 *    cuts access at once. Rotating the secret signs out every connector.
 *
 * The human step reuses the web app's Slack sign-in through `getUser`, so this
 * file never touches a session, a cookie or a Slack credential.
 */

export const CLIENT_TTL_S = 60 * 60 * 24 * 365;
export const REQUEST_TTL_S = 60 * 10;
export const CODE_TTL_S = 60;
export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 60 * 60 * 24 * 90;
const MAX_REDIRECTS = 5;

/** The signed-in, already-authorized user, as the web app sees them. */
export interface OAuthUser { slackUserId: string; name: string | null }

export interface OAuthDeps {
  env?: NodeJS.ProcessEnv;
  /** Milliseconds since epoch. Injectable so expiry is testable. */
  now?: () => number;
  /** The signed-in, authorized user for THIS request, or null. */
  getUser: () => Promise<OAuthUser | null>;
  /** The same allowlist the web app uses; re-checked on every token use. */
  isAllowed: (slackUserId: string) => boolean;
}

// --- configuration ---------------------------------------------------------

function secretOf(env: NodeJS.ProcessEnv): string | null {
  const s = env.MCP_OAUTH_SECRET?.trim();
  return s && s.length >= 32 ? s : null;
}

/** True when a usable signing secret exists. Never reveals it. */
export function isOAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return secretOf(env) !== null;
}

// --- signed blobs ----------------------------------------------------------

type Kind = 'client' | 'req' | 'code' | 'access' | 'refresh';
type Payload = Record<string, unknown> & { t: Kind; exp: number };

const b64u = (b: Buffer): string => b.toString('base64url');

function sign(payload: Payload, secret: string): string {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`;
}

/** Returns the payload only if the signature, the kind and the expiry all hold. */
function verify(token: string, kind: Kind, secret: string, nowMs: number): Payload | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const offered = Buffer.from(sig, 'base64url');
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) return null;
  let payload: Payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (payload.t !== kind) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
  return payload;
}

const nowOf = (deps: OAuthDeps): number => (deps.now ?? Date.now)();
const expiry = (deps: OAuthDeps, ttlS: number): number => Math.floor(nowOf(deps) / 1000) + ttlS;

// --- redirect URIs ---------------------------------------------------------

/**
 * Exact-match allowlist of the connector hosts, plus loopback for native
 * clients (RFC 8252 — Claude Code listens on an ephemeral port). Anything else
 * is refused at registration AND at authorization, so a registered client can
 * never name a destination outside this list.
 *
 * Hosts confirmed against current docs 2026-10-06:
 * claude.ai and claude.com `/api/mcp/auth_callback`; ChatGPT
 * `/connector/oauth/<id>` plus its legacy `/connector_platform_oauth_redirect`
 * and the app-review `platform.openai.com/apps-manage/oauth`.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'http:') {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  }
  if (u.protocol !== 'https:' || u.port || u.search) return false;
  const key = `${u.hostname}${u.pathname}`;
  if ([
    'claude.ai/api/mcp/auth_callback',
    'claude.com/api/mcp/auth_callback',
    'chatgpt.com/connector_platform_oauth_redirect',
    'platform.openai.com/apps-manage/oauth',
  ].includes(key)) return true;
  return u.hostname === 'chatgpt.com' && /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname);
}

// --- metadata --------------------------------------------------------------

export const resourceOf = (origin: string): string => `${origin}/mcp`;

export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceOf(origin),
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  };
}

/** Where a 401 should point a client that wants to sign in. */
export const resourceMetadataUrl = (origin: string): string =>
  `${origin}/.well-known/oauth-protected-resource/mcp`;

// --- helpers ---------------------------------------------------------------

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const oauthError = (error: string, description?: string, status = 400): Response =>
  json(description ? { error, error_description: description } : { error }, status);

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const originOf = (request: Request): string => new URL(request.url).origin;

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>` +
    `:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;` +
    `display:grid;place-items:center;min-height:100vh;padding:16px}` +
    `main{max-width:420px;width:100%}h1{font-size:1.25rem}` +
    `ul{padding-left:1.2rem}.row{display:flex;gap:12px;margin-top:24px}` +
    `button{flex:1;font:inherit;padding:12px;border-radius:8px;border:1px solid #888;cursor:pointer}` +
    `button.go{background:#1a1a2e;color:#fff;border-color:#1a1a2e}` +
    `small{opacity:.7}</style></head><body><main>${body}</main></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The consent screen must never be framed: a click on it grants access.
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http:",
        'referrer-policy': 'no-referrer',
      },
    }
  );
}

const problem = (message: string): Response =>
  page('Cannot connect', `<h1>Cannot connect</h1><p>${esc(message)}</p>`, 400);

function redirectTo(redirectUri: string, params: Record<string, string | undefined>, status = 302): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return new Response(null, { status, headers: { location: u.toString(), 'cache-control': 'no-store' } });
}

// --- /oauth/register -------------------------------------------------------

/** RFC 7591 dynamic client registration, restricted to allowlisted redirects. */
export async function handleRegister(request: Request, deps: OAuthDeps): Promise<Response> {
  const secret = secretOf(deps.env ?? process.env);
  if (!secret) return oauthError('server_error', 'OAuth is not configured', 503);

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 8192) return oauthError('invalid_client_metadata', 'request too large');
    body = JSON.parse(text);
  } catch {
    return oauthError('invalid_client_metadata', 'body must be JSON');
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECTS ||
      !uris.every((u): u is string => typeof u === 'string')) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be 1-5 strings');
  }
  if (!uris.every(isAllowedRedirectUri)) {
    return oauthError('invalid_redirect_uri', 'redirect_uri is not an allowed connector callback');
  }
  const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 80) : '';
  const clientId = sign({ t: 'client', ru: uris, nm: name, exp: expiry(deps, CLIENT_TTL_S) }, secret);
  return json({
    client_id: clientId,
    client_name: name || undefined,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(nowOf(deps) / 1000),
  }, 201);
}

// --- /oauth/authorize ------------------------------------------------------

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * GET: validate, send to Slack sign-in if needed, show the consent screen.
 * POST: the consent decision. Both live here so the pieces cannot drift.
 */
export async function handleAuthorize(request: Request, deps: OAuthDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  const secret = secretOf(env);
  if (!secret) return problem('This server is not set up for connectors yet.');
  const origin = originOf(request);
  const resource = resourceOf(origin);

  if (request.method === 'POST') return decide(request, deps, secret, origin);

  const q = new URL(request.url).searchParams;
  const client = verify(q.get('client_id') ?? '', 'client', secret, nowOf(deps));
  const redirectUri = q.get('redirect_uri') ?? '';
  // Until the client and its redirect are proven, never redirect anywhere: an
  // error sent to an unverified URI is an open redirect.
  if (!client) return problem('Unknown or expired client. Remove the connector and add it again.');
  const registered = client.ru as string[];
  if (!registered.includes(redirectUri) || !isAllowedRedirectUri(redirectUri)) {
    return problem('That redirect address is not registered for this client.');
  }

  const state = q.get('state') ?? undefined;
  const fail = (error: string, description: string) =>
    redirectTo(redirectUri, { error, error_description: description, state, iss: origin });

  if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  const challenge = q.get('code_challenge') ?? '';
  if (q.get('code_challenge_method') !== 'S256' || !PKCE_CHALLENGE.test(challenge)) {
    return fail('invalid_request', 'PKCE with S256 is required');
  }
  const asked = q.get('resource');
  if (asked && asked !== resource) return fail('invalid_target', 'unknown resource');

  const user = await deps.getUser();
  if (!user || !deps.isAllowed(user.slackUserId)) {
    const next = `/oauth/authorize${new URL(request.url).search}`;
    return new Response(null, {
      status: 302,
      headers: { location: `${origin}/signin?next=${encodeURIComponent(next)}`, 'cache-control': 'no-store' },
    });
  }

  // Bound to this user and short-lived. The POST accepts only this token, so
  // the approval cannot be forged from another site or replayed for a different
  // client, redirect or challenge.
  const req = sign({
    t: 'req', ru: redirectUri, cid: q.get('client_id'), cc: challenge,
    st: state ?? null, aud: resource, uid: user.slackUserId, exp: expiry(deps, REQUEST_TTL_S),
  }, secret);
  const clientName = (client.nm as string) || 'An app';
  const host = new URL(redirectUri).hostname;
  return page('Connect to Team Riley Tasks', `
    <h1>Connect ${esc(clientName)} to your tasks?</h1>
    <p>Signed in as <strong>${esc(user.name ?? user.slackUserId)}</strong>.</p>
    <p>This will let it:</p>
    <ul><li>read your tasks and Spaces</li>
        <li>create tasks, and complete or move them when you ask</li></ul>
    <p><small>It can never rename a task. Returns you to ${esc(host)}.</small></p>
    <form method="post" action="${esc(origin)}/oauth/authorize">
      <input type="hidden" name="req" value="${esc(req)}">
      <div class="row">
        <button type="submit" name="decision" value="deny">Cancel</button>
        <button type="submit" name="decision" value="approve" class="go">Approve</button>
      </div>
    </form>`);
}

async function decide(request: Request, deps: OAuthDeps, secret: string, origin: string): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const req = verify(form.get('req') ?? '', 'req', secret, nowOf(deps));
  if (!req) return problem('This approval link expired. Start the connection again.');
  const user = await deps.getUser();
  if (!user || !deps.isAllowed(user.slackUserId) || user.slackUserId !== req.uid) {
    return problem('You are not signed in as the person who started this connection.');
  }
  const redirectUri = req.ru as string;
  const state = (req.st as string | null) ?? undefined;
  if (form.get('decision') !== 'approve') {
    return redirectTo(redirectUri, { error: 'access_denied', state, iss: origin }, 303);
  }
  const code = sign({
    t: 'code', cid: req.cid, ru: redirectUri, cc: req.cc, uid: req.uid, aud: req.aud,
    exp: expiry(deps, CODE_TTL_S),
  }, secret);
  return redirectTo(redirectUri, { code, state, iss: origin }, 303);
}

// --- /oauth/token ----------------------------------------------------------

function issueTokens(
  deps: OAuthDeps, secret: string, grant: { uid: string; aud: string; cid: string }
): Response {
  return json({
    access_token: sign({ t: 'access', uid: grant.uid, aud: grant.aud, exp: expiry(deps, ACCESS_TTL_S) }, secret),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: sign({ t: 'refresh', uid: grant.uid, aud: grant.aud, cid: grant.cid, exp: expiry(deps, REFRESH_TTL_S) }, secret),
  });
}

export async function handleToken(request: Request, deps: OAuthDeps): Promise<Response> {
  const secret = secretOf(deps.env ?? process.env);
  if (!secret) return oauthError('server_error', 'OAuth is not configured', 503);
  const resource = resourceOf(originOf(request));

  const text = await request.text();
  if (text.length > 8192) return oauthError('invalid_request');
  const f = new URLSearchParams(text);
  const clientId = f.get('client_id') ?? '';
  // 401 invalid_client is how a client learns to register again.
  if (!verify(clientId, 'client', secret, nowOf(deps))) return oauthError('invalid_client', undefined, 401);
  const asked = f.get('resource');
  if (asked && asked !== resource) return oauthError('invalid_target');

  const grantType = f.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = verify(f.get('code') ?? '', 'code', secret, nowOf(deps));
    if (!code || code.cid !== clientId || code.ru !== f.get('redirect_uri')) {
      return oauthError('invalid_grant');
    }
    const verifier = f.get('code_verifier') ?? '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError('invalid_grant');
    const got = createHash('sha256').update(verifier).digest();
    const want = Buffer.from(String(code.cc), 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return oauthError('invalid_grant');
    if (!deps.isAllowed(String(code.uid))) return oauthError('invalid_grant');
    return issueTokens(deps, secret, { uid: String(code.uid), aud: String(code.aud), cid: clientId });
  }

  if (grantType === 'refresh_token') {
    const rt = verify(f.get('refresh_token') ?? '', 'refresh', secret, nowOf(deps));
    if (!rt || rt.cid !== clientId || rt.aud !== resource) return oauthError('invalid_grant');
    if (!deps.isAllowed(String(rt.uid))) return oauthError('invalid_grant');
    return issueTokens(deps, secret, { uid: String(rt.uid), aud: String(rt.aud), cid: clientId });
  }

  return oauthError('unsupported_grant_type');
}

// --- using an access token on /mcp ----------------------------------------

/**
 * The Slack user an OAuth access token speaks for, or null.
 *
 * Re-checks the allowlist on every call, which is what makes removing a person
 * from AUTHORIZED_SLACK_USER_IDS take effect immediately rather than when their
 * token expires. Also requires the token was issued for THIS resource.
 */
export function authorizeOAuthAccess(
  request: Request, deps: Pick<OAuthDeps, 'env' | 'now' | 'isAllowed'>
): { slackUserId: string } | null {
  const secret = secretOf(deps.env ?? process.env);
  if (!secret) return null;
  const header = request.headers.get('authorization') ?? '';
  if (!/^Bearer\s+/i.test(header)) return null;
  const at = verify(header.replace(/^Bearer\s+/i, ''), 'access', secret, (deps.now ?? Date.now)());
  if (!at || at.aud !== resourceOf(originOf(request))) return null;
  const uid = String(at.uid);
  return deps.isAllowed(uid) ? { slackUserId: uid } : null;
}
