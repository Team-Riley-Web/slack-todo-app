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
  // task-core defines it; the Slack modal submit handler is its only caller
  // until the web UI lands in Phase 2B. Nothing on a Hermes surface.
  expect(callers).toEqual([
    'apps/slack/src/handlers/edit-modal.ts',
    'packages/task-core/src/tasks.ts',
  ]);
});

it('resolves tasks by uuid only — every mutation guards with assertTaskId', async () => {
  const tasks = (await allSources()).find(({ file }) => file.endsWith('task-core/src/tasks.ts'))!;
  for (const fn of ['completeTask', 'reopenTask', 'moveTask', 'getTask']) {
    const body = tasks.text.slice(tasks.text.indexOf(`export async function ${fn}`));
    expect(body.slice(0, 600)).toContain('assertTaskId');
  }
});
