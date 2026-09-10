import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * These spawn the real CLI entry points. Unit tests exercise the underlying
 * functions directly, which cannot catch a script that fails to resolve its
 * own imports — exactly how the sync-channels dotenv resolution bug escaped.
 */

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tr-cli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it('pnpm migrate runs standalone', async () => {
  await withScratch(async (dir) => {
    const { stdout } = await run('pnpm', ['migrate'], {
      env: { ...process.env, DATABASE_URL: `file://${join(dir, 'db')}` },
    });
    expect(stdout).toContain('migrations applied');
  });
}, 90_000);

it('pnpm sync-channels applies a config file standalone', async () => {
  await withScratch(async (dir) => {
    const cfg = join(dir, 'channel-map.json');
    await writeFile(cfg, JSON.stringify({
      C_SECURE: { name: '#client-secure-logic', space: 'Client - Secure Logic' },
      C_AGENCY: { name: '#agency-ops', space: 'agency-internal' },
    }));
    const { stdout } = await run('pnpm', ['sync-channels'], {
      env: {
        ...process.env,
        DATABASE_URL: `file://${join(dir, 'db')}`,
        CHANNEL_MAP_PATH: cfg,
      },
    });
    expect(stdout).toContain('2 upserted');
    expect(stdout).toContain('#client-secure-logic');
    expect(stdout).toContain('Agency / Internal');
  });
}, 90_000);

it('pnpm sync-channels fails helpfully when the config is missing', async () => {
  await withScratch(async (dir) => {
    await expect(run('pnpm', ['sync-channels'], {
      env: {
        ...process.env,
        DATABASE_URL: `file://${join(dir, 'db')}`,
        CHANNEL_MAP_PATH: join(dir, 'does-not-exist.json'),
      },
    })).rejects.toThrow(/No channel map at/);
  });
}, 90_000);

it('pnpm sync-channels rejects an unknown space and writes nothing', async () => {
  await withScratch(async (dir) => {
    const cfg = join(dir, 'channel-map.json');
    await writeFile(cfg, JSON.stringify({
      C_GOOD: { space: 'Marketing' },
      C_BAD: { space: 'Client - Does Not Exist' },
    }));
    await expect(run('pnpm', ['sync-channels'], {
      env: {
        ...process.env,
        DATABASE_URL: `file://${join(dir, 'db')}`,
        CHANNEL_MAP_PATH: cfg,
      },
    })).rejects.toThrow(/Unknown space/);
  });
}, 90_000);

// `prune` is a pnpm built-in that prunes node_modules, and pnpm gives its own
// commands precedence over scripts — a script named `prune` was shadowed, so
// running it would have pruned packages instead of the database.
it('the interaction prune script is not shadowed by a pnpm built-in', async () => {
  await withScratch(async (dir) => {
    const { stdout } = await run('pnpm', ['prune-interactions'], {
      env: { ...process.env, DATABASE_URL: `file://${join(dir, 'db')}` },
    });
    expect(stdout).toMatch(/pruned 0 interaction\(s\) older than 7 days/);
  });
}, 90_000);

it('no npm script name collides with a pnpm built-in command', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const builtins = new Set([
    'prune', 'install', 'add', 'remove', 'update', 'list', 'why', 'audit',
    'publish', 'pack', 'link', 'unlink', 'import', 'rebuild', 'store', 'exec',
    'dlx', 'create', 'init', 'run', 'test', 'start', 'env', 'server', 'setup',
    'fetch', 'deploy', 'licenses', 'outdated', 'patch', 'dedupe', 'approve-builds',
  ]);
  // `test` and `start` are conventional npm lifecycle scripts, not shadowed.
  const conventional = new Set(['test', 'start']);
  const collisions = Object.keys(pkg.scripts)
    .filter((name) => builtins.has(name) && !conventional.has(name));
  expect(collisions).toEqual([]);
}, 30_000);
