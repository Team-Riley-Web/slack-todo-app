import { describe, it, expect } from 'vitest';
import { withCardLock } from './lock.js';

describe('withCardLock', () => {
  it('serializes work on the same key', async () => {
    const order: string[] = [];
    const slow = async (tag: string, ms: number) => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
    };
    await Promise.all([
      withCardLock('k', () => slow('a', 30)),
      withCardLock('k', () => slow('b', 1)),
      withCardLock('k', () => slow('c', 1)),
    ]);
    // No interleaving: each start is immediately followed by its own end.
    expect(order).toEqual([
      'a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end',
    ]);
  });

  it('does not serialize across different keys', async () => {
    const order: string[] = [];
    await Promise.all([
      withCardLock('k1', async () => {
        order.push('k1:start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('k1:end');
      }),
      withCardLock('k2', async () => {
        order.push('k2:start');
        order.push('k2:end');
      }),
    ]);
    expect(order.indexOf('k2:end')).toBeLessThan(order.indexOf('k1:end'));
  });

  it('releases the lock when the body throws', async () => {
    await expect(withCardLock('k', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    await expect(withCardLock('k', async () => 'after')).resolves.toBe('after');
  });
});
