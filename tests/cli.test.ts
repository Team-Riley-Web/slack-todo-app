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

// --- importer CLI ---

const scratchDb = (dir: string) => ({
  ...process.env, DATABASE_URL: `file://${join(dir, 'db')}`,
});

it('previews an import and writes nothing without --confirm', async () => {
  await withScratch(async (dir) => {
    const { stdout } = await run('pnpm', [
      'import-tasks', '--', '--file', 'docs/workast-export-2026-09-09.json',
      '--type', 'workast', '--map', 'config/workast-mapping.json',
    ], { env: scratchDb(dir), maxBuffer: 10 * 1024 * 1024 });

    expect(stdout).toMatch(/READY TO IMPORT\s+21/);
    expect(stdout).toContain('Nothing was written');
    // Titles appear byte-exact in the preview.
    expect(stdout).toContain('Waiting on Milltown’s reply to the email proposal');
    expect(stdout).toContain('Secure Logic — three-month honeymoon check-in with Marty');
  });
}, 120_000);

it('imports with --confirm and reports the batch id', async () => {
  await withScratch(async (dir) => {
    const env = scratchDb(dir);
    const { stdout } = await run('pnpm', [
      'import-tasks', '--', '--file', 'docs/workast-export-2026-09-09.json',
      '--type', 'workast', '--map', 'config/workast-mapping.json',
      '--confirm', '--actor', 'U_JOSH',
    ], { env, maxBuffer: 10 * 1024 * 1024 });

    expect(stdout).toMatch(/imported\s+21/);
    expect(stdout).toMatch(/failed\s+0/);
    expect(stdout).toMatch(/roll back with/);

    // A second run is a no-op.
    const again = await run('pnpm', [
      'import-tasks', '--', '--file', 'docs/workast-export-2026-09-09.json',
      '--type', 'workast', '--map', 'config/workast-mapping.json',
    ], { env, maxBuffer: 10 * 1024 * 1024 });
    expect(again.stdout).toMatch(/SKIP - DUPLICATE\s+21/);
  });
}, 180_000);

it('refuses --confirm without an actor', async () => {
  await withScratch(async (dir) => {
    await expect(run('pnpm', [
      'import-tasks', '--', '--file', 'docs/workast-export-2026-09-09.json',
      '--type', 'workast', '--confirm',
    ], { env: scratchDb(dir), maxBuffer: 10 * 1024 * 1024 }))
      .rejects.toThrow(/requires --actor/);
  });
}, 120_000);

it('rejects a file whose contents disagree with its declared type', async () => {
  await withScratch(async (dir) => {
    const csv = join(dir, 'actually-json.csv');
    await writeFile(csv, '[{"title":"T"}]');
    await expect(run('pnpm', [
      'import-tasks', '--', '--file', csv, '--type', 'csv',
    ], { env: scratchDb(dir) })).rejects.toThrow(/contents look like json/);
  });
}, 120_000);

it('lists batches and shows one batch audit summary', async () => {
  await withScratch(async (dir) => {
    const env = scratchDb(dir);
    await run('pnpm', [
      'import-tasks', '--', '--file', 'docs/workast-export-2026-09-09.json',
      '--type', 'workast', '--map', 'config/workast-mapping.json',
      '--confirm', '--actor', 'U_JOSH',
    ], { env, maxBuffer: 10 * 1024 * 1024 });

    const list = await run('pnpm', ['import-tasks', '--', '--list'], { env });
    expect(list.stdout).toContain('IMPORTED');
    expect(list.stdout).toContain('workast');

    const id = list.stdout.split('\n').find((l) => l.includes('IMPORTED'))!.split(/\s+/)[0]!;
    const one = await run('pnpm', ['import-tasks', '--', '--batch', id], { env });
    expect(one.stdout).toContain('state    IMPORTED');
    expect(one.stdout).toMatch(/IMPORTED\s+21/);
  });
}, 180_000);

it('rolls a batch back from the CLI', async () => {
  await withScratch(async (dir) => {
    const env = scratchDb(dir);
    const imported = await run('pnpm', [
      'import-tasks', '--', '--file', 'docs/workast-export-2026-09-09.json',
      '--type', 'workast', '--map', 'config/workast-mapping.json',
      '--confirm', '--actor', 'U_JOSH',
    ], { env, maxBuffer: 10 * 1024 * 1024 });
    const id = /batch ([0-9a-f-]{36}) at /.exec(imported.stdout)![1]!;

    const back = await run('pnpm', ['import-tasks', '--', '--rollback', id], { env });
    expect(back.stdout).toMatch(/rolled back 21 task/);
  });
}, 180_000);
