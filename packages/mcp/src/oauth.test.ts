import { it, expect, describe, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import {
  handleRegister, handleAuthorize, handleToken, authorizeOAuthAccess,
  isAllowedRedirectUri, protectedResourceMetadata, authorizationServerMetadata,
  type OAuthDeps, ACCESS_TTL_S, CODE_TTL_S,
} from './oauth.js';
import { handleMcpHttpRequest, mcpHealth } from './http.js';

const ORIGIN = 'https://tasks.example.com';
const SECRET = 'x'.repeat(40);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const env = { MCP_OAUTH_SECRET: SECRET, TASKS_MCP_TOKEN: 'hermes-static-token-value' } as unknown as NodeJS.ProcessEnv;

let clock = 1_800_000_000_000;
let user: { slackUserId: string; name: string | null } | null;
let allowed: Set<string>;
const deps = (): OAuthDeps => ({
  env, now: () => clock, getUser: async () => user, isAllowed: (id) => allowed.has(id),
});

beforeEach(() => {
  clock = 1_800_000_000_000;
  user = { slackUserId: 'U_JOSH', name: 'Josh' };
  allowed = new Set(['U_JOSH']);
});

const verifier = () => randomBytes(32).toString('base64url');
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');

async function register(redirect = REDIRECT, name = 'Claude') {
  const res = await handleRegister(new Request(`${ORIGIN}/oauth/register`, {
    method: 'POST', body: JSON.stringify({ redirect_uris: [redirect], client_name: name }),
  }), deps());
  return { res, body: await res.json() as any };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const u = new URL(`${ORIGIN}/oauth/authorize`);
  const q = {
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st-1',
    code_challenge: challenge, code_challenge_method: 'S256', ...extra,
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

const tokenReq = (params: Record<string, string>) => new Request(`${ORIGIN}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

/** Full happy path up to a code. */
async function getCode() {
  const { body: client } = await register();
  const v = verifier();
  const page = await handleAuthorize(new Request(authorizeUrl(client.client_id, challengeOf(v))), deps());
  const html = await page.text();
  const req = /name="req" value="([^"]+)"/.exec(html)![1]!;
  const decision = await handleAuthorize(new Request(`${ORIGIN}/oauth/authorize`, {
    method: 'POST', body: new URLSearchParams({ req, decision: 'approve' }).toString(),
  }), deps());
  const loc = new URL(decision.headers.get('location')!);
  return { client, v, code: loc.searchParams.get('code')!, loc, decision };
}

describe('metadata', () => {
  it('points the resource at /mcp and the server at its own endpoints', () => {
    expect(protectedResourceMetadata(ORIGIN)).toMatchObject({
      resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN],
    });
    expect(authorizationServerMetadata(ORIGIN)).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
  });
});

describe('redirect allowlist', () => {
  it('accepts the documented connector callbacks and loopback', () => {
    for (const u of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
      'https://chatgpt.com/connector/oauth/abc_123-X',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'http://localhost:54321/callback',
      'http://127.0.0.1:8080/cb',
    ]) expect(isAllowedRedirectUri(u), u).toBe(true);
  });
  it('refuses everything else', () => {
    for (const u of [
      'https://evil.example/cb', 'https://claude.ai.evil.example/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback?x=1', 'https://claude.ai/other',
      'http://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector/oauth/a/b',
      'http://evil.example/cb', 'javascript:alert(1)', 'not a url',
      'https://claude.ai:8443/api/mcp/auth_callback',
    ]) expect(isAllowedRedirectUri(u), u).toBe(false);
  });
  it('is enforced at registration', async () => {
    const { res, body } = await register('https://evil.example/cb');
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_redirect_uri');
  });
});

describe('authorize', () => {
  it('sends a signed-out visitor to Slack sign-in and back', async () => {
    const { body: client } = await register();
    user = null;
    const url = authorizeUrl(client.client_id, challengeOf(verifier()));
    const res = await handleAuthorize(new Request(url), deps());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/signin');
    expect(loc.searchParams.get('next')).toBe(`/oauth/authorize${new URL(url).search}`);
  });

  it('treats a user who is not on the allowlist as signed out', async () => {
    const { body: client } = await register();
    user = { slackUserId: 'U_STRANGER', name: 'Stranger' };
    const res = await handleAuthorize(new Request(authorizeUrl(client.client_id, challengeOf(verifier()))), deps());
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/signin');
  });

  it('shows a consent screen that cannot be framed, escaping the client name', async () => {
    const reg = await handleRegister(new Request(`${ORIGIN}/oauth/register`, {
      method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: '<script>x</script>' }),
    }), deps());
    const { client_id } = await reg.json() as any;
    const res = await handleAuthorize(new Request(authorizeUrl(client_id, challengeOf(verifier()))), deps());
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Approve');
  });

  it('never redirects to an unverified client or an unregistered redirect', async () => {
    const bad = await handleAuthorize(new Request(authorizeUrl('forged.client', challengeOf(verifier()))), deps());
    expect(bad.status).toBe(400);
    expect(bad.headers.get('location')).toBeNull();

    const { body: client } = await register();
    const other = await handleAuthorize(new Request(
      authorizeUrl(client.client_id, challengeOf(verifier()), { redirect_uri: 'https://claude.com/api/mcp/auth_callback' })
    ), deps());
    expect(other.status).toBe(400);
    expect(other.headers.get('location')).toBeNull();
  });

  it('requires PKCE S256 and the right resource', async () => {
    const { body: client } = await register();
    const plain = await handleAuthorize(new Request(
      authorizeUrl(client.client_id, 'short', { code_challenge_method: 'plain' })
    ), deps());
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    const wrong = await handleAuthorize(new Request(
      authorizeUrl(client.client_id, challengeOf(verifier()), { resource: 'https://other.example/mcp' })
    ), deps());
    expect(new URL(wrong.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('returns access_denied with the state when the user cancels', async () => {
    const { body: client } = await register();
    const page = await handleAuthorize(new Request(authorizeUrl(client.client_id, challengeOf(verifier()))), deps());
    const req = /name="req" value="([^"]+)"/.exec(await page.text())![1]!;
    const res = await handleAuthorize(new Request(`${ORIGIN}/oauth/authorize`, {
      method: 'POST', body: new URLSearchParams({ req, decision: 'deny' }).toString(),
    }), deps());
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st-1');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('rejects an approval from a different signed-in user than the one who asked', async () => {
    const { body: client } = await register();
    const page = await handleAuthorize(new Request(authorizeUrl(client.client_id, challengeOf(verifier()))), deps());
    const req = /name="req" value="([^"]+)"/.exec(await page.text())![1]!;
    allowed.add('U_OTHER');
    user = { slackUserId: 'U_OTHER', name: 'Other' };
    const res = await handleAuthorize(new Request(`${ORIGIN}/oauth/authorize`, {
      method: 'POST', body: new URLSearchParams({ req, decision: 'approve' }).toString(),
    }), deps());
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('rejects a tampered or expired approval token', async () => {
    const { body: client } = await register();
    const page = await handleAuthorize(new Request(authorizeUrl(client.client_id, challengeOf(verifier()))), deps());
    const req = /name="req" value="([^"]+)"/.exec(await page.text())![1]!;
    const post = (r: string) => handleAuthorize(new Request(`${ORIGIN}/oauth/authorize`, {
      method: 'POST', body: new URLSearchParams({ req: r, decision: 'approve' }).toString(),
    }), deps());
    expect((await post(req.slice(0, -2) + 'AA')).status).toBe(400);
    clock += 11 * 60 * 1000;
    expect((await post(req)).status).toBe(400);
  });
});

describe('token', () => {
  it('completes the whole flow and the access token reaches /mcp', async () => {
    const { client, v, code, loc } = await getCode();
    expect(loc.searchParams.get('state')).toBe('st-1');
    expect(loc.searchParams.get('iss')).toBe(ORIGIN);

    const res = await handleToken(tokenReq({
      grant_type: 'authorization_code', code, code_verifier: v,
      client_id: client.client_id, redirect_uri: REDIRECT,
    }), deps());
    const tok = await res.json() as any;
    expect(res.status).toBe(200);
    expect(tok.token_type).toBe('Bearer');
    expect(tok.expires_in).toBe(ACCESS_TTL_S);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const mcp = new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${tok.access_token}` } });
    expect(authorizeOAuthAccess(mcp, deps())).toEqual({ slackUserId: 'U_JOSH' });
  });

  async function exchange(extra: Record<string, string | undefined> = {}, c?: Awaited<ReturnType<typeof getCode>>) {
    const g = c ?? await getCode();
    const params: Record<string, string> = {
      grant_type: 'authorization_code', code: g.code, code_verifier: g.v,
      client_id: g.client.client_id, redirect_uri: REDIRECT,
    };
    for (const [k, val] of Object.entries(extra)) { if (val === undefined) delete params[k]; else params[k] = val; }
    const res = await handleToken(tokenReq(params), deps());
    return { res, body: await res.json() as any };
  }

  it('rejects a wrong PKCE verifier, redirect, client, expired or tampered code', async () => {
    expect((await exchange({ code_verifier: verifier() })).body.error).toBe('invalid_grant');
    expect((await exchange({ code_verifier: undefined })).body.error).toBe('invalid_grant');
    expect((await exchange({ redirect_uri: 'https://claude.com/api/mcp/auth_callback' })).body.error).toBe('invalid_grant');

    const g = await getCode();
    const other = await register(REDIRECT, 'A different app');
    expect((await exchange({ client_id: other.body.client_id }, g)).body.error).toBe('invalid_grant');
    expect((await exchange({ code: g.code.slice(0, -2) + 'AA' }, g)).body.error).toBe('invalid_grant');
    clock += (CODE_TTL_S + 1) * 1000;
    expect((await exchange({}, g)).body.error).toBe('invalid_grant');
  });

  it('answers a forged client id with 401 invalid_client so the client re-registers', async () => {
    const { res, body } = await exchange({ client_id: 'forged' });
    expect(res.status).toBe(401);
    expect(body.error).toBe('invalid_client');
  });

  it('refreshes, and stops refreshing once the user is off the allowlist', async () => {
    const g = await getCode();
    const first = (await exchange({}, g)).body;
    const refresh = (rt: string) => handleToken(tokenReq({
      grant_type: 'refresh_token', refresh_token: rt, client_id: g.client.client_id,
    }), deps());
    const ok = await refresh(first.refresh_token);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).access_token).toBeTruthy();

    allowed.delete('U_JOSH');
    const denied = await refresh(first.refresh_token);
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as any).error).toBe('invalid_grant');
  });

  it('does not accept an access token as a refresh token, or the reverse', async () => {
    const g = await getCode();
    const tok = (await exchange({}, g)).body;
    const asRefresh = await handleToken(tokenReq({
      grant_type: 'refresh_token', refresh_token: tok.access_token, client_id: g.client.client_id,
    }), deps());
    expect(asRefresh.status).toBe(400);
    const mcp = new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${tok.refresh_token}` } });
    expect(authorizeOAuthAccess(mcp, deps())).toBeNull();
  });
});

describe('/mcp with OAuth', () => {
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { await db.close(); });

  const call = (token: string | null, e = env) => handleMcpHttpRequest(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    { getDb: async () => db, env: e, isAllowed: (id) => allowed.has(id), now: () => clock }
  );

  async function accessToken(): Promise<string> {
    const g = await getCode();
    const res = await handleToken(tokenReq({
      grant_type: 'authorization_code', code: g.code, code_verifier: g.v,
      client_id: g.client.client_id, redirect_uri: REDIRECT,
    }), deps());
    return ((await res.json()) as any).access_token;
  }

  it('lists the same tools for an OAuth token and for the Hermes token', async () => {
    const viaOauth = await call(await accessToken());
    const viaStatic = await call('hermes-static-token-value');
    expect(viaOauth.status).toBe(200);
    expect(viaStatic.status).toBe(200);
    const names = async (r: Response) => {
      const text = await r.text();
      const data = text.startsWith('event:') || text.startsWith('data:')
        ? text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : text;
      return JSON.parse(data).result.tools.map((t: any) => t.name).sort();
    };
    const a = await names(viaOauth);
    expect(a).toEqual(await names(viaStatic));
    expect(a).toContain('create_tasks');
  });

  it('401s with a pointer to the sign-in flow, and nothing else', async () => {
    const res = await call(null);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`
    );
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('401s on an expired token and on a user removed from the allowlist', async () => {
    const token = await accessToken();
    allowed.delete('U_JOSH');
    expect((await call(token)).status).toBe(401);
    allowed.add('U_JOSH');
    expect((await call(token)).status).toBe(200);
    clock += (ACCESS_TTL_S + 1) * 1000;
    expect((await call(token)).status).toBe(401);
  });

  it('401s every OAuth token when the secret rotates', async () => {
    const token = await accessToken();
    const rotated = { ...env, MCP_OAUTH_SECRET: 'y'.repeat(40) } as unknown as NodeJS.ProcessEnv;
    expect((await call(token, rotated)).status).toBe(401);
  });

  it('keeps the Hermes token working, and gives no sign-in hint without a secret', async () => {
    const noSecret = { TASKS_MCP_TOKEN: 'hermes-static-token-value' } as unknown as NodeJS.ProcessEnv;
    expect((await call('hermes-static-token-value', noSecret)).status).toBe(200);
    const denied = await call(null, noSecret);
    expect(denied.headers.get('www-authenticate')).not.toContain('resource_metadata');
  });

  it('reports that OAuth is configured, never the secret', () => {
    const h = mcpHealth(env);
    expect(h.oauth).toBe(true);
    expect(JSON.stringify(h)).not.toContain(SECRET);
    expect(mcpHealth({ TASKS_MCP_TOKEN: 'x' } as never).oauth).toBe(false);
  });
});

describe('without a secret', () => {
  it('refuses every OAuth endpoint', async () => {
    const bare = { ...deps(), env: {} as NodeJS.ProcessEnv };
    expect((await handleRegister(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', body: '{}' }), bare)).status).toBe(503);
    expect((await handleToken(tokenReq({ grant_type: 'refresh_token' }), bare)).status).toBe(503);
    expect((await handleAuthorize(new Request(`${ORIGIN}/oauth/authorize`), bare)).status).toBe(400);
  });
  it('treats a short secret as no secret', async () => {
    const weak = { ...deps(), env: { MCP_OAUTH_SECRET: 'short' } as unknown as NodeJS.ProcessEnv };
    expect((await handleRegister(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', body: '{}' }), weak)).status).toBe(503);
  });
});
