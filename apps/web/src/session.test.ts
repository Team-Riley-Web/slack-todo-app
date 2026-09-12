import { describe, it, expect } from 'vitest';
import { authorizeSlackUser, devUser } from './session.js';

const env = (over: Record<string, string | undefined>) => over as NodeJS.ProcessEnv;

describe('authorizeSlackUser', () => {
  it('admits a listed user', () => {
    expect(authorizeSlackUser('U_JOSH', env({
      AUTHORIZED_SLACK_USER_IDS: 'U_JOSH,U_RACHAEL',
    }))).toBe(true);
  });

  it('denies a user who is not listed', () => {
    expect(authorizeSlackUser('U_STRANGER', env({
      AUTHORIZED_SLACK_USER_IDS: 'U_JOSH,U_RACHAEL',
    }))).toBe(false);
  });

  // The single most important assertion in this file.
  it('denies EVERYONE when the allowlist is empty or missing', () => {
    for (const list of [undefined, '', '   ', ',', ' , , ']) {
      expect(
        authorizeSlackUser('U_JOSH', env({ AUTHORIZED_SLACK_USER_IDS: list })),
        `allowlist ${JSON.stringify(list)} must deny`
      ).toBe(false);
    }
  });

  it('denies a missing user id', () => {
    for (const id of [null, undefined, '']) {
      expect(authorizeSlackUser(id, env({ AUTHORIZED_SLACK_USER_IDS: 'U_JOSH' })))
        .toBe(false);
    }
  });

  it('tolerates whitespace around ids in the environment variable', () => {
    expect(authorizeSlackUser('U_JOSH', env({
      AUTHORIZED_SLACK_USER_IDS: '  U_JOSH , U_RACHAEL  ',
    }))).toBe(true);
  });

  it('is exact, not a substring match', () => {
    expect(authorizeSlackUser('U_JOS', env({ AUTHORIZED_SLACK_USER_IDS: 'U_JOSH' })))
      .toBe(false);
    expect(authorizeSlackUser('U_JOSHUA', env({ AUTHORIZED_SLACK_USER_IDS: 'U_JOSH' })))
      .toBe(false);
  });
});

describe('the development bypass', () => {
  it('supplies a user in development when the variable is set', () => {
    expect(devUser(env({ WEB_DEV_USER: 'U_JOSH', NODE_ENV: 'development' })))
      .toEqual({ slackUserId: 'U_JOSH', name: null });
  });

  it('is INERT in production even when the variable is set', () => {
    expect(devUser(env({ WEB_DEV_USER: 'U_JOSH', NODE_ENV: 'production' })))
      .toBeNull();
  });

  it('returns null with no variable, in any environment', () => {
    for (const nodeEnv of ['development', 'test', 'production', undefined]) {
      expect(devUser(env({ NODE_ENV: nodeEnv }))).toBeNull();
    }
  });

  it('ignores a whitespace-only variable', () => {
    expect(devUser(env({ WEB_DEV_USER: '   ', NODE_ENV: 'development' }))).toBeNull();
  });

  it('supplies identity, not authority', () => {
    // A dev user must still clear the allowlist.
    const user = devUser(env({ WEB_DEV_USER: 'U_DEV', NODE_ENV: 'development' }))!;
    expect(user.slackUserId).toBe('U_DEV');
    expect(authorizeSlackUser(user.slackUserId, env({
      AUTHORIZED_SLACK_USER_IDS: 'U_JOSH',
    }))).toBe(false);
    expect(authorizeSlackUser(user.slackUserId, env({
      AUTHORIZED_SLACK_USER_IDS: 'U_DEV',
    }))).toBe(true);
  });
});

describe('the year-long session', () => {
  /**
   * A one-year session is only defensible because access is re-checked on
   * every request rather than baked into the token. These two assertions are
   * the pair: the session is long, AND removing an id revokes immediately.
   */
  it('is a year, and is wired into the session config', async () => {
    // Read as source, not imported: auth.ts pulls in next-auth, which needs
    // the Next runtime that vitest does not provide.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('apps/web/src/auth.ts', 'utf8');
    expect(src).toContain('SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365');
    expect(src).toContain("session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS }");
  });

  it('pins the workspace so Slack never asks which one', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('apps/web/src/auth.ts', 'utf8');
    expect(src).toContain('params: { team: process.env.SLACK_TEAM_ID.trim() }');
    // Sent only when set. Slack rejects an empty `team=`, which would break
    // sign-in entirely rather than merely showing the picker.
    expect(src).toContain('process.env.SLACK_TEAM_ID?.trim()');
    expect(src).toContain(': undefined');
  });

  it('grants nothing once the id leaves the allowlist', () => {
    const listed = { AUTHORIZED_SLACK_USER_IDS: 'U_JOSH,U_RACHAEL' } as never;
    expect(authorizeSlackUser('U_RACHAEL', listed)).toBe(true);

    // Same still-valid session, id removed from the environment.
    const revoked = { AUTHORIZED_SLACK_USER_IDS: 'U_JOSH' } as never;
    expect(authorizeSlackUser('U_RACHAEL', revoked)).toBe(false);
  });
});
