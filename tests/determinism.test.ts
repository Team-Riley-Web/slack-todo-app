import { it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOTS = ['packages', 'apps'];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Every scan below is looking for what the code DOES. Prose explaining why a
 * responsibility moved to Hermes, or which EOS meetings it took with it, is
 * documentation and must not trip a guard — the same trap the importer's
 * fuzzy-match scan and `no-secrets.test.ts` both hit. The `[^:]` guard keeps
 * `https://` out of the line-comment rule.
 */
export function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function allSources(): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const root of ROOTS) {
    for (const file of await sourceFiles(root)) {
      out.push({ file, text: await readFile(file, 'utf8') });
    }
  }
  return out;
}

/**
 * The title guarantee changed shape in Phase 2A, deliberately.
 *
 * Before: no code path could write `tasks.title` at all. Now exactly one can,
 * because a human needs to fix their own typo. The threat this guarantee exists
 * to stop was never that - it was AI silently rewriting what the user said. So
 * the assertion moves from "no title write exists" to "exactly one exists, at a
 * known path, and it is unreachable from the surfaces Hermes speaks through".
 */
it('has exactly one title write path, and it is in task-core', async () => {
  const offenders = (await allSources())
    .filter(({ text }) => /UPDATE\s+tasks[\s\S]{0,400}?\btitle\b\s*=/i.test(text))
    .map(({ file }) => file);
  expect(offenders).toEqual(['packages/task-core/src/tasks.ts']);
});

it('never exposes editTask through the Hermes surfaces', async () => {
  const mcp = await readFile('packages/mcp/src/tools.ts', 'utf8');
  const rest = await readFile('apps/api/src/server.ts', 'utf8');
  expect(mcp.includes('editTask'), 'MCP must not reference editTask').toBe(false);
  expect(rest.includes('editTask'), 'REST must not reference editTask').toBe(false);

  const { TOOL_NAMES } = await import('../packages/mcp/src/tools.js');
  expect((TOOL_NAMES as string[]).some((n) => /title|rename/i.test(n))).toBe(false);
});

it('contains no fuzzy title matching in any mutation path', async () => {
  const offenders = (await allSources())
    .filter(({ text }) =>
      /\btitle\s+(I?LIKE|~)/i.test(text) || /WHERE[^;`]*lower\(\s*title\s*\)/is.test(text))
    .map(({ file }) => file);
  expect(offenders).toEqual([]);
});

it('makes no LLM or AI service calls', async () => {
  const offenders = (await allSources())
    .filter(({ text }) =>
      /api\.openai\.com|anthropic\.com\/v1|generativelanguage\.googleapis|api\.cohere/i.test(text))
    .map(({ file }) => file);
  expect(offenders).toEqual([]);
});

it('exposes no title-mutating export from any package entry point', async () => {
  const entries = [
    '../packages/task-core/src/index.js',
    '../packages/slack-ui/src/index.js',
  ];
  for (const mod of entries) {
    const loaded = (await import(mod)) as Record<string, unknown>;
    const bad = Object.keys(loaded).filter((n) => /renameTask|updateTitle|setTitle|editTitle/i.test(n));
    expect(bad).toEqual([]);
  }
});

it('keeps editTask reachable only from human surfaces', async () => {
  const callers = (await allSources())
    .filter(({ text }) => /\beditTask\s*\(/.test(text))
    .map(({ file }) => file)
    .sort();
  // task-core defines it. Its callers are the two HUMAN surfaces: the Slack
  // modal submit handler and the web operations layer. Nothing on a Hermes
  // surface may appear in this list.
  expect(callers).toEqual([
    'apps/slack/src/handlers/edit-modal.ts',
    'apps/web/src/operations/tasks.ts',
    'packages/task-core/src/tasks.ts',
  ]);
});

/**
 * Scheduled delivery must stand on its own.
 *
 * The brief is explicit: the scheduled task posts are plain cron jobs reading
 * the task database, and they keep working with every AI surface
 * switched off. MCP and Hermes may LATER consume the same functions for
 * planning and prioritisation -- the dependency runs that way and never back,
 * so an outage or a bad model response cannot cost you your morning list.
 */
it('keeps the scheduler independent of every Hermes and MCP surface', async () => {
  const scheduler = (await allSources())
    .filter(({ file }) => file.startsWith(join('packages', 'scheduler')));
  expect(scheduler.length).toBeGreaterThan(0);

  const offenders = scheduler
    .filter(({ text }) => /@tr\/mcp|\bhermes\b/i.test(codeOnly(text)))
    .map(({ file }) => file);
  expect(offenders).toEqual([]);
});

/**
 * Remote MCP (2026-09-11) put the tool surface on a public HTTPS endpoint.
 * That raises the stakes on the rule it must not break: Hermes may read tasks
 * and create them, and may never rewrite one. Asserted against the exported
 * name list, so a tool added later is caught wherever it was defined.
 */
it('exposes no title- or priority-mutating tool on either MCP transport', async () => {
  const { TOOL_NAMES } = await import('../packages/mcp/src/tools.js');
  expect(TOOL_NAMES.some(
    (n: string) => /edit|rename|update_task|set_title|set_priority/i.test(n)
  )).toBe(false);
  // The five that can write, unchanged. A sixth is a decision, not an accident.
  const writers = ['create_task', 'create_task_for_context', 'complete_task',
    'move_task', 'set_task_details'];
  for (const w of writers) expect(TOOL_NAMES).toContain(w);
});

it('keeps remote MCP behind a credential of its own', async () => {
  const { authorizeMcpRequest } = await import('../packages/mcp/src/http.js');
  // Unset denies; the REST API's token is NOT accepted here, so revoking one
  // does not revoke the other.
  expect(authorizeMcpRequest('Bearer anything', {} as never)).toBe(false);
  expect(authorizeMcpRequest('Bearer rest-token',
    { TASKS_MCP_TOKEN: 'mcp-token-value' } as never)).toBe(false);
  expect(authorizeMcpRequest('Bearer mcp-token-value',
    { TASKS_MCP_TOKEN: 'mcp-token-value' } as never)).toBe(true);
});

/**
 * Scheduling ownership: the Tasks app delivers its weekly task briefings and
 * nothing else (2026-10-06; the two daily posts before that, 2026-09-11). EOS
 * reminders moved to Hermes, and this asserts they did not quietly stay
 * behind -- and that the daily posts did not either.
 */
it('schedules only the weekly task briefings, with no EOS or daily post left behind', async () => {
  const { FIXED_BRIEFINGS } = await import('../packages/scheduler/src/schedule.js');
  expect([...FIXED_BRIEFINGS]).toEqual(['agency', 'personal']);

  const scheduler = (await allSources())
    .filter(({ file }) => file.startsWith(join('packages', 'scheduler')));
  const eos = scheduler
    .filter(({ text }) => /level.?10|same.?page|quarterly|eos/i.test(codeOnly(text)))
    .map(({ file }) => file);
  expect(eos).toEqual([]);

  const daily = scheduler
    .filter(({ text }) => /agency-daily|personal-daily|— Today/.test(codeOnly(text)))
    .map(({ file }) => file);
  expect(daily).toEqual([]);
});

it('resolves tasks by uuid only — every mutation guards with assertTaskId', async () => {
  const tasks = (await allSources()).find(({ file }) => file.endsWith('task-core/src/tasks.ts'))!;
  for (const fn of ['completeTask', 'reopenTask', 'moveTask', 'getTask']) {
    const body = tasks.text.slice(tasks.text.indexOf(`export async function ${fn}`));
    expect(body.slice(0, 600)).toContain('assertTaskId');
  }
});
