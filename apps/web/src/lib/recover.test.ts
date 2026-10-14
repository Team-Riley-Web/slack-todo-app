import { describe, it, expect } from 'vitest';
import { isStaleDeployError, shouldAutoReload } from './recover.js';

describe('isStaleDeployError', () => {
  it('recognises the errors a reload fixes', () => {
    for (const message of [
      'Failed to find Server Action "7f3a". This request might be from an older or newer deployment.',
      'Loading chunk 482 failed.',
      'Failed to fetch dynamically imported module: https://x/_next/static/chunks/a.js',
    ]) {
      expect(isStaleDeployError({ message })).toBe(true);
    }
    expect(isStaleDeployError({ name: 'ChunkLoadError', message: '' })).toBe(true);
  });

  it('leaves ordinary bugs alone, so they are not hidden by a reload loop', () => {
    expect(isStaleDeployError({ message: "Cannot read properties of undefined (reading 'id')" }))
      .toBe(false);
    expect(isStaleDeployError(null)).toBe(false);
  });
});

describe('shouldAutoReload', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  };

  it('reloads once, then not again within 30 seconds', () => {
    const s = memory();
    expect(shouldAutoReload(s, '/', 1_000_000)).toBe(true);
    expect(shouldAutoReload(s, '/', 1_010_000)).toBe(false);
    expect(shouldAutoReload(s, '/', 1_031_000)).toBe(true);
  });

  it('never reloads automatically without storage', () => {
    expect(shouldAutoReload(null, '/')).toBe(false);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
    expect(shouldAutoReload(broken, '/')).toBe(false);
  });
});
