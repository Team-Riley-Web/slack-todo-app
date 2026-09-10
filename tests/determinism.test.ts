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

// Required test 18, enforced repository-wide
it('contains no title-mutating SQL anywhere', async () => {
  const offenders = (await allSources())
    .filter(({ text }) => /UPDATE\s+tasks\s+SET[^;`]*\btitle\b/is.test(text))
    .map(({ file }) => file);
  expect(offenders).toEqual([]);
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

it('resolves tasks by uuid only — every mutation guards with assertTaskId', async () => {
  const tasks = (await allSources()).find(({ file }) => file.endsWith('task-core/src/tasks.ts'))!;
  for (const fn of ['completeTask', 'reopenTask', 'moveTask', 'getTask']) {
    const body = tasks.text.slice(tasks.text.indexOf(`export async function ${fn}`));
    expect(body.slice(0, 600)).toContain('assertTaskId');
  }
});
