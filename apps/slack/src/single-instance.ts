import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Refuses to start when another instance is already running.
 *
 * Socket Mode lets several processes hold connections to the same app, and
 * Slack delivers each event to exactly ONE of them. So a forgotten instance
 * does not fail loudly -- it quietly serves a share of the traffic with
 * whatever code it started with.
 *
 * That cost a real debugging session: three instances were running, the oldest
 * predated a feature, and roughly a third of commands came back behaving as
 * if the feature had never been written. The database was right, the tests
 * were right, and the app was wrong at random.
 *
 * A pidfile turns that into a startup error.
 */

export interface LockResult {
  acquired: boolean;
  /** The pid holding the lock, when acquisition failed. */
  heldBy?: number;
  release: () => Promise<void>;
}

/** True when a process with this pid exists and we may signal it. */
export function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireLock(
  path: string, pid: number = process.pid
): Promise<LockResult> {
  const noop = async (): Promise<void> => {};

  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing !== null) {
    const held = Number(existing.trim());
    if (isRunning(held) && held !== pid) {
      return { acquired: false, heldBy: held, release: noop };
    }
    // A stale pidfile from a crash is not a reason to refuse to start.
  }

  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, `${pid}\n`, 'utf8');

  return {
    acquired: true,
    release: async () => {
      // Only remove it if it is still ours, so a later instance's lock is not
      // deleted by this one shutting down late.
      const current = await readFile(path, 'utf8').catch(() => null);
      if (current !== null && Number(current.trim()) === pid) {
        await unlink(path).catch(() => {});
      }
    },
  };
}
