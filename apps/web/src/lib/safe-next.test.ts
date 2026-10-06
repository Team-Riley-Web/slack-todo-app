import { it, expect } from 'vitest';
import { safeNext } from './safe-next.js';

it('keeps an OAuth authorize path with its query', () => {
  const next = '/oauth/authorize?response_type=code&client_id=a.b&state=x%20y';
  expect(safeNext(next)).toBe(next);
  expect(safeNext([next, 'https://evil.example'])).toBe(next);
});

it('falls back to / for anything that could leave the site or the flow', () => {
  for (const bad of [
    undefined, '', '/', '/today', 'https://evil.example/oauth/authorize?x=1',
    '//evil.example/oauth/authorize?x=1', '/oauth/authorize', '/oauth/authorizeX?x=1',
    '/oauth/authorize?x=1 y', '/oauth/authorize?\\evil', 'javascript:alert(1)',
  ]) expect(safeNext(bad as string | undefined), String(bad)).toBe('/');
});
