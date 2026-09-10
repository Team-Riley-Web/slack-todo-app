import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import {
  settingsView, setChannelMapping, removeChannelMapping, removeSpace,
} from './operations/settings.js';
import { getSpaceForChannel, listSpaces, createTask } from '@tr/task-core';

let db: Db;
const ORIGINAL = { ...process.env };

beforeEach(async () => {
  db = await createTestDb();
  // Real-shaped credentials in the environment while the page renders, so the
  // scan below is testing something rather than passing by absence.
  process.env.SLACK_BOT_TOKEN = 'xoxb-1111111111-2222222222-abcdefghijklmnop';
  process.env.SLACK_APP_TOKEN = 'xapp-1-A0000000-1111111111-deadbeef';
  process.env.SLACK_SIGNING_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.AUTH_SLACK_SECRET = 'sk-live-should-never-render';
  process.env.AUTH_SECRET = 'super-secret-session-key';
  process.env.API_TOKEN = 'sk-api-token-value';
  process.env.DATABASE_URL = 'postgres://user:hunter2@db.example.com:6543/postgres';
  process.env.AUTHORIZED_SLACK_USER_IDS = 'U_JOSH,U_RACHAEL';
  process.env.DEFAULT_TIMEZONE = 'America/Chicago';
});
afterEach(async () => {
  await db.close();
  process.env = { ...ORIGINAL };
});

const CREDENTIAL_SHAPES = [
  /xox[abposr]-/i,
  /xapp-/i,
  /\bsk-[a-z0-9-]{6,}/i,
  /postgres(ql)?:\/\//i,
  /hunter2/,
  /super-secret-session-key/,
];

describe('the settings view renders no credential', () => {
  it('contains nothing credential-shaped', async () => {
    const view = await settingsView(db);
    const serialized = JSON.stringify(view);
    for (const shape of CREDENTIAL_SHAPES) {
      expect(serialized, `matched ${shape}`).not.toMatch(shape);
    }
  });

  it('still reports the things that are not secret', async () => {
    const view = await settingsView(db);
    expect(view.authorizedUserIds).toEqual(['U_JOSH', 'U_RACHAEL']);
    expect(view.timeZone).toBe('America/Chicago');
    expect(view.defaultSpaceName).toBe('Inbox');
    expect(view.spaces).toHaveLength(12);
  });

  it('shows the channel map and import history without leaking anything', async () => {
    await setChannelMapping(db, 'C_AGENCY', '#agency-ops', 'Agency / Internal');
    await db.query(
      `INSERT INTO import_batches (source_type, filename, state, row_count)
       VALUES ('workast', 'export.json', 'IMPORTED', 21)`
    );

    const view = await settingsView(db);
    expect(view.channels).toEqual([
      { channelId: 'C_AGENCY', channelName: '#agency-ops', spaceName: 'Agency / Internal' },
    ]);
    expect(view.batches).toHaveLength(1);
    expect(view.batches[0]!.filename).toBe('export.json');

    const serialized = JSON.stringify(view);
    for (const shape of CREDENTIAL_SHAPES) {
      expect(serialized).not.toMatch(shape);
    }
  });
});

describe('no page reads a secret from the environment', () => {
  /**
   * A grep, so a page added later cannot quietly start rendering a token. The
   * allowlist of readable values lives in src/lib/env.ts and is enforced here.
   */
  const FORBIDDEN = [
    'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET',
    'AUTH_SLACK_SECRET', 'AUTH_SECRET', 'API_TOKEN', 'DATABASE_URL',
    'WEB_DEV_USER',
  ];

  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(path)));
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        out.push(path);
      }
    }
    return out;
  };

  it('no file under src/app references a secret env var', async () => {
    const offenders: string[] = [];
    for (const file of await walk('apps/web/src/app')) {
      const text = await readFile(file, 'utf8');
      for (const name of FORBIDDEN) {
        if (text.includes(name)) offenders.push(`${file} -> ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no component references a secret env var', async () => {
    const offenders: string[] = [];
    for (const file of await walk('apps/web/src/components')) {
      const text = await readFile(file, 'utf8');
      for (const name of FORBIDDEN) {
        if (text.includes(name)) offenders.push(`${file} -> ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only two files read a credential, and both have a reason to', async () => {
    // Comments are stripped first: auth.ts documents the env names Auth.js
    // expects without reading them, and the guard should test code rather than
    // the prose explaining it - the same trap the importer's fuzzy-match scan
    // hit.
    const readers: string[] = [];
    for (const file of await walk('apps/web/src')) {
      const raw = await readFile(file, 'utf8');
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (FORBIDDEN.some((name) => code.includes(name))) readers.push(file);
    }
    // Each of these three has a reason, and no page or component is among them:
    //   actions/tasks.ts  needs the bot token to redraw a Slack card
    //   session.ts        needs WEB_DEV_USER for the fail-closed local bypass
    //   db.ts             checks DATABASE_URL is Postgres before connecting
    expect(readers.sort()).toEqual([
      'apps/web/src/actions/tasks.ts',
      'apps/web/src/db.ts',
      'apps/web/src/session.ts',
    ]);
  });
});

describe('settings mutations', () => {
  it('adds a mapping that takes effect immediately', async () => {
    expect((await setChannelMapping(db, 'C_NEW', '#new', 'Marketing')).ok).toBe(true);
    const resolved = await getSpaceForChannel(db, 'C_NEW');
    expect(resolved.space.name).toBe('Marketing');
    expect(resolved.mapped).toBe(true);
  });

  it('remaps rather than duplicating', async () => {
    await setChannelMapping(db, 'C_NEW', '#new', 'Marketing');
    await setChannelMapping(db, 'C_NEW', '#new', 'Sales');
    expect((await getSpaceForChannel(db, 'C_NEW')).space.name).toBe('Sales');
    expect((await settingsView(db)).channels).toHaveLength(1);
  });

  it('refuses an unknown Space and changes nothing', async () => {
    const result = await setChannelMapping(db, 'C_NEW', '#new', 'Nowhere Client');
    expect(result.ok).toBe(false);
    expect((await settingsView(db)).channels).toEqual([]);
  });

  it('refuses a blank channel id', async () => {
    expect((await setChannelMapping(db, '   ', null, 'Marketing')).ok).toBe(false);
  });

  it('removes one mapping and leaves the others', async () => {
    await setChannelMapping(db, 'C_A', '#a', 'Marketing');
    await setChannelMapping(db, 'C_B', '#b', 'Sales');
    expect((await removeChannelMapping(db, 'C_A')).ok).toBe(true);
    const view = await settingsView(db);
    expect(view.channels.map((c) => c.channelId)).toEqual(['C_B']);
    expect((await getSpaceForChannel(db, 'C_A')).mapped).toBe(false);
  });
});

describe('deleting a Space from the web', () => {
  const spaceNamed = async (name: string) =>
    (await listSpaces(db)).find((s) => s.name === name)!;

  it('deletes an empty Space', async () => {
    const yoga = await spaceNamed('Client - Yoga Farm');
    expect((await removeSpace(db, yoga.id)).ok).toBe(true);
    expect((await listSpaces(db)).some((s) => s.id === yoga.id)).toBe(false);
  });

  it('refuses a Space holding tasks, with a message that says why', async () => {
    const marketing = await spaceNamed('Marketing');
    await createTask(db, { title: 'Still here', spaceId: marketing.id });
    const result = await removeSpace(db, marketing.id);
    expect(result.ok).toBe(false);
    // OperationResult is a discriminated union; narrow before reading `error`.
    if (!result.ok) expect(result.error).toContain('task');
    expect((await listSpaces(db)).some((s) => s.id === marketing.id)).toBe(true);
  });

  it('refuses Inbox', async () => {
    const inbox = (await listSpaces(db)).find((s) => s.is_inbox)!;
    expect((await removeSpace(db, inbox.id)).ok).toBe(false);
  });

  it('drops the deleted Space out of the settings view', async () => {
    const before = (await settingsView(db)).spaces.length;
    const yoga = await spaceNamed('Client - Yoga Farm');
    await removeSpace(db, yoga.id);
    expect((await settingsView(db)).spaces).toHaveLength(before - 1);
  });
});

describe('Space ordering in the web data layer', () => {
  it('puts Inbox first, then alphabetical by displayed name', async () => {
    const shown = (await settingsView(db)).spaces
      .map((s) => s.name.replace(/^Client - /, ''));
    expect(shown[0]).toBe('Inbox');
    const rest = shown.slice(1);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });
});

describe('the completion control is actually operable', () => {
  /**
   * The bug this guards: the row rendered a readOnly <input type="checkbox">
   * beside a hidden submit button. A checkbox does not submit a form, and this
   * app ships no client JavaScript to submit one for it, so completing a task
   * from the web was impossible. Verified in a real browser before the fix and
   * after.
   */
  /**
   * Comments are stripped first. The first version of these guards matched the
   * comment explaining the bug and failed on prose -- the same trap the
   * importer's fuzzy-match scan and the credential scan above both hit.
   */
  const rowSource = async (): Promise<string> => {
    const raw = await readFile('apps/web/src/components/TaskRow.tsx', 'utf8');
    return raw
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  };

  it('uses a submit button, not a checkbox input', async () => {
    const src = await rowSource();
    expect(src).not.toMatch(/type="checkbox"/);
    expect(src).toMatch(/type="submit"/);
  });

  it('has no hidden submit button, which nothing could click', async () => {
    const src = await rowSource();
    expect(src).not.toMatch(/<button[^>]*\bhidden\b/);
  });

  it('never marks the control readOnly', async () => {
    expect(await rowSource()).not.toMatch(/\breadOnly\b/);
  });
});
