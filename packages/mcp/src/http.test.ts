import { it, expect, beforeEach, afterEach, describe } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { authorizeMcpRequest, handleMcpHttpRequest, mcpHealth } from './http.js';
import { createMcpServer } from './server.js';
import { buildTools, TOOL_NAMES } from './tools.js';

let db: Db;
let spaceId: string;

const TOKEN = 'a-long-enough-mcp-token-value';
const env = { TASKS_MCP_TOKEN: TOKEN } as unknown as NodeJS.ProcessEnv;

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Client - Nazareth Law'`
  );
  spaceId = rows[0]!.id;
});
afterEach(async () => { await db.close(); });

let nextId = 1;
/** One JSON-RPC call over the HTTP transport, as a real MCP client makes it. */
async function rpc(
  method: string, params: Record<string, unknown> = {}, token: string | null = TOKEN
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // A real client advertises both, and the transport may answer with either.
    accept: 'application/json, text/event-stream',
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;

  const res = await handleMcpHttpRequest(
    new Request('https://tasks.example.com/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    }),
    { getDb: async () => db, env }
  );

  const text = await res.text();
  if (!text) return { status: res.status, body: null };
  // Streamable HTTP may frame a single response as one SSE event.
  const json = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim())
    : JSON.parse(text);
  return { status: res.status, body: json };
}

/** MCP wraps every tool result as JSON in a text content block. */
const payload = (body: any) => JSON.parse(body.result.content[0].text);

const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0.0' },
};

describe('authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const r = await rpc('initialize', INIT, null);
    expect(r.status).toBe(401);
  });

  it('rejects an invalid bearer token', async () => {
    const r = await rpc('initialize', INIT, 'not-the-right-token-at-all!');
    expect(r.status).toBe(401);
  });

  it('rejects a token of the right length but wrong value', async () => {
    expect(authorizeMcpRequest(`Bearer ${'x'.repeat(TOKEN.length)}`, env)).toBe(false);
  });

  it('denies everything when no token is configured', async () => {
    // A deployment that forgot TASKS_MCP_TOKEN must be closed, not open.
    expect(authorizeMcpRequest(`Bearer ${TOKEN}`, {} as never)).toBe(false);
    expect(authorizeMcpRequest(null, {} as never)).toBe(false);
  });

  it('leaks nothing about the credential in the rejection', async () => {
    const res = await handleMcpHttpRequest(
      new Request('https://tasks.example.com/mcp', { method: 'POST' }),
      { getDb: async () => db, env }
    );
    const text = await res.text();
    expect(res.status).toBe(401);
    expect(text).not.toContain(TOKEN);
    expect(text).toBe(JSON.stringify({ error: 'unauthorized' }));
  });

  it('initializes with a valid bearer token', async () => {
    const r = await rpc('initialize', INIT);
    expect(r.status).toBe(200);
    expect(r.body.result.serverInfo.name).toBe('team-riley-tasks');
  });
});

describe('the contract is the same on both transports', () => {
  it('exposes exactly the stdio tool names over HTTP', async () => {
    const r = await rpc('tools/list');
    const overHttp = r.body.result.tools.map((t: any) => t.name).sort();
    const overStdio = buildTools(db).map((t) => t.name).sort();
    expect(overHttp).toEqual(overStdio);
    expect(overHttp).toEqual([...TOOL_NAMES].sort());
  });

  it('builds the same server object for stdio as for HTTP', () => {
    // Both transports call createMcpServer and nothing else, so a tool cannot
    // exist on one and not the other.
    expect(createMcpServer(db)).toBeDefined();
  });

  it('exposes no title-mutating or edit tool over HTTP', async () => {
    const names: string[] = (await rpc('tools/list')).body.result.tools.map((t: any) => t.name);
    expect(names.some((n) => /edit|rename|update_task|set_title|set_priority/i.test(n)))
      .toBe(false);
    // The one tool that writes a title does so only at creation.
    expect(names).toContain('create_task');
  });
});

describe('tools over the HTTP transport', () => {
  const callTool = (name: string, args: Record<string, unknown> = {}) =>
    rpc('tools/call', { name, arguments: args });

  it('reads spaces and tasks', async () => {
    const spaces = payload((await callTool('list_spaces')).body);
    expect(spaces.spaces.length).toBeGreaterThan(0);
    const tasks = payload((await callTool('list_tasks')).body);
    expect(tasks.tasks).toEqual([]);
  });

  it('creates a task with its title byte-exact apart from the opening letter', async () => {
    const raw = 'Offer Neil Instagram and Facebook package for $100';
    const { task } = payload((await callTool('create_task', {
      title: raw, space_id: spaceId,
    })).body);
    expect(task.title).toBe(raw);
  });

  it('carries the canonical priority through', async () => {
    const { task } = payload((await callTool('create_task', {
      title: 'Fix Stripe checkout', space_id: spaceId, priority: 'P0',
    })).body);
    expect(task.priority).toBe('P0');
  });

  it('preserves channel routing and says where the Space came from', async () => {
    await db.query(
      `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
       SELECT 'C_SECURE', '#client-secure-logic', id FROM spaces
        WHERE name = 'Client - Secure Logic'`
    );
    const byChannel = payload((await callTool('create_task_for_context', {
      channel_id: 'C_SECURE', title: 'From the channel',
    })).body);
    expect(byChannel.space.name).toBe('Client - Secure Logic');
    expect(byChannel.resolved_from).toBe('channel');

    const explicit = payload((await callTool('create_task_for_context', {
      channel_id: 'C_SECURE', title: 'Explicit override', space: 'Agency / Internal',
    })).body);
    expect(explicit.space.name).toBe('Agency / Internal');
    expect(explicit.resolved_from).toBe('explicit');
  });

  it('fails an unknown explicit Space rather than guessing a fallback', async () => {
    const r = await callTool('create_task_for_context', {
      channel_id: 'C_SECURE', title: 'X', space: 'Some Other Client',
    });
    expect(JSON.stringify(r.body)).toMatch(/Unknown space/i);
  });

  it('targets mutations by uuid only, with no fuzzy title lookup', async () => {
    const { task } = payload((await callTool('create_task', {
      title: 'Real task', space_id: spaceId,
    })).body);
    // A title where a uuid belongs is rejected, not resolved by search.
    const byTitle = await callTool('complete_task', { task_id: 'Real task' });
    expect(JSON.stringify(byTitle.body)).toMatch(/invalid task id/i);

    const byId = payload((await callTool('complete_task', { task_id: task.id })).body);
    expect(byId.task.status).toBe('completed');
  });
});

describe('health', () => {
  it('reports alive without exposing the token or any task', () => {
    const h = mcpHealth(env);
    expect(h).toEqual({
      ok: true, service: 'team-riley-tasks-mcp', transport: 'streamable-http',
      tools: TOOL_NAMES.length, configured: true,
    });
    expect(JSON.stringify(h)).not.toContain(TOKEN);
  });

  it('reports not-ok when no token is configured', () => {
    expect(mcpHealth({} as never).ok).toBe(false);
  });
});

describe('the documented contract matches the code', () => {
  /**
   * MCP_CONTRACT.md said "Eight tools" for months while `TOOL_NAMES` held
   * twenty — nobody noticed because nothing compared them. This is that
   * comparison. The doc is what Hermes is built against, so a tool that exists
   * only in one of the two places is a contract bug either way.
   */
  it('lists exactly the same tools in MCP_CONTRACT.md as in TOOL_NAMES', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = await readFile('MCP_CONTRACT.md', 'utf8');
    // Every tool is a table row opening with the name in backticks.
    const documented = [...doc.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]!);

    expect([...new Set(documented)].sort()).toEqual([...TOOL_NAMES].sort());
    expect(documented).toHaveLength(TOOL_NAMES.length);
  });

  it('states the right tool count in prose', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = await readFile('MCP_CONTRACT.md', 'utf8');
    expect(doc).toContain(`Twenty tools`);
    expect(TOOL_NAMES).toHaveLength(20);
  });

  it('documents the five writers, and only those five', async () => {
    const writers = [
      'create_task', 'create_task_for_context', 'complete_task',
      'move_task', 'set_task_details',
    ];
    for (const w of writers) expect(TOOL_NAMES).toContain(w);
    // Everything else must be a read. Named explicitly so adding a mutation
    // is a deliberate edit here, not a silent one in tools.ts.
    const reads = TOOL_NAMES.filter((n) => !writers.includes(n));
    expect(reads).toHaveLength(15);
  });
});

describe('nothing leaks the credential', () => {
  it('keeps the token out of everything the HTTP path writes to the console', async () => {
    const seen: string[] = [];
    const spy = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
    const real = { log: console.log, error: console.error, warn: console.warn };
    console.log = spy; console.error = spy; console.warn = spy;
    try {
      await rpc('initialize', INIT);                       // authorized
      await rpc('tools/list');                             // authorized
      await rpc('initialize', INIT, null);                 // no header
      await rpc('initialize', INIT, 'wrong-token-value!!'); // bad header
    } finally {
      console.log = real.log; console.error = real.error; console.warn = real.warn;
    }
    expect(seen.join('\n')).not.toContain(TOKEN);
  });

  it('never returns the token in a tool response', async () => {
    const body = await rpc('tools/call', { name: 'list_spaces', arguments: {} });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});
