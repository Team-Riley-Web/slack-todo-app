import { it, expect } from 'vitest';
import { authorize } from './auth.js';

const base = { team: { id: 'T_RILEY' }, user: { id: 'U_JOSH' } } as never;

it('accepts a workspace member when no allowlist is configured', () => {
  expect(authorize(base, { teamId: 'T_RILEY', authorizedUserIds: [] }))
    .toEqual({ ok: true, userId: 'U_JOSH' });
});

// Required test 16
it('rejects a user from another workspace', () => {
  expect(authorize(
    { team: { id: 'T_OTHER' }, user: { id: 'U_JOSH' } } as never,
    { teamId: 'T_RILEY', authorizedUserIds: [] }
  ).ok).toBe(false);
});

it('rejects a user outside a configured allowlist', () => {
  expect(authorize(base, { teamId: 'T_RILEY', authorizedUserIds: ['U_OTHER'] }).ok).toBe(false);
});

it('accepts a user inside a configured allowlist', () => {
  expect(authorize(base, { teamId: 'T_RILEY', authorizedUserIds: ['U_JOSH', 'U_X'] }))
    .toEqual({ ok: true, userId: 'U_JOSH' });
});

it('rejects a payload with no user id', () => {
  expect(authorize({ team: { id: 'T_RILEY' } } as never,
    { teamId: 'T_RILEY', authorizedUserIds: [] }).ok).toBe(false);
});

it('rejects when the team id is absent from the payload', () => {
  expect(authorize({ user: { id: 'U_JOSH' } } as never,
    { teamId: 'T_RILEY', authorizedUserIds: [] }).ok).toBe(false);
});

it('fails closed when SLACK_TEAM_ID is unconfigured', () => {
  expect(authorize(base, { teamId: '', authorizedUserIds: [] }))
    .toEqual({ ok: false, reason: 'unconfigured_team' });
});
