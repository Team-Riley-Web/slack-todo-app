import { it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, isRunning } from './single-instance.js';

let dir: string | null = null;
const lockPath = async (): Promise<string> => {
  dir = await mkdtemp(join(tmpdir(), 'slack-lock-'));
  return join(dir, 'nested', '.slack.pid');
};
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

it('acquires a lock and records the pid', async () => {
  const path = await lockPath();
  const lock = await acquireLock(path, 4242);
  expect(lock.acquired).toBe(true);
  expect((await readFile(path, 'utf8')).trim()).toBe('4242');
});

it('creates the directory if it is missing', async () => {
  const path = await lockPath();
  expect((await acquireLock(path, 1)).acquired).toBe(true);
});

it('refuses when a live process holds the lock', async () => {
  const path = await lockPath();
  // This test's own pid is certainly alive.
  await acquireLock(path, process.pid);
  const second = await acquireLock(path, process.pid + 1);
  expect(second.acquired).toBe(false);
  expect(second.heldBy).toBe(process.pid);
});

it('takes over a stale pidfile left by a crash', async () => {
  const path = await lockPath();
  // A pid that cannot be running: kernels do not hand out 2^31.
  await acquireLock(path, 1);
  await writeFile(path, '2147483646\n', 'utf8');
  const lock = await acquireLock(path, 777);
  expect(lock.acquired).toBe(true);
  expect((await readFile(path, 'utf8')).trim()).toBe('777');
});

it('is re-entrant for the same pid, so a restart in place is not blocked', async () => {
  const path = await lockPath();
  await acquireLock(path, process.pid);
  expect((await acquireLock(path, process.pid)).acquired).toBe(true);
});

it('releases only its own lock', async () => {
  const path = await lockPath();
  const mine = await acquireLock(path, 4242);
  // Someone else took over in the meantime.
  await writeFile(path, '9999\n', 'utf8');
  await mine.release();
  expect((await readFile(path, 'utf8')).trim()).toBe('9999');
});

it('removes the pidfile when it is still ours', async () => {
  const path = await lockPath();
  const lock = await acquireLock(path, 4242);
  await lock.release();
  await expect(readFile(path, 'utf8')).rejects.toThrow();
});

it('treats a garbage pidfile as stale rather than crashing', async () => {
  const path = await lockPath();
  await acquireLock(path, 1);
  await writeFile(path, 'not-a-pid\n', 'utf8');
  expect((await acquireLock(path, 555)).acquired).toBe(true);
});

it('reports a nonsense pid as not running', () => {
  expect(isRunning(0)).toBe(false);
  expect(isRunning(-1)).toBe(false);
  expect(isRunning(NaN)).toBe(false);
  expect(isRunning(process.pid)).toBe(true);
});
