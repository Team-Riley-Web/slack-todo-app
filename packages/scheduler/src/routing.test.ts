import { describe, it, expect } from 'vitest';
import type { Space } from '@tr/task-core';
import { findBriefing, planBriefings, type ChannelMapping } from './routing.js';
import type { SchedulerConfig } from './config.js';
import {
  DEFAULT_AGENCY_SPACES, DEFAULT_PERSONAL_SPACES, loadSchedulerConfig,
} from './config.js';

const space = (name: string, slug: string, isInbox = false): Space => ({
  id: `id-${slug}`, name, slug, is_inbox: isInbox,
});

const SPACES: Space[] = [
  space('Inbox', 'inbox', true),
  space('Agency / Internal', 'agency-internal'),
  space('Marketing', 'marketing'),
  space('Sales', 'sales'),
  space('Personal', 'personal'),
  space('Music', 'music'),
  space('Finances', 'finances'),
  space('Client - Joy Within Birth', 'joy-within-birth'),
  space('Client - Yoga Farm', 'yoga-farm'),
];

const config: SchedulerConfig = {
  timeZone: 'America/Chicago',
  agencyChannelId: 'C_AGENCY',
  personalChannelId: 'C_PERSONAL',
  agencySpaceKeys: DEFAULT_AGENCY_SPACES,
  personalSpaceKeys: DEFAULT_PERSONAL_SPACES,
  topPerSpace: 10,
  assigneeLabels: {},
};

const map = (channelId: string, slug: string): ChannelMapping =>
  ({ channelId, spaceId: `id-${slug}` });

const MAPPINGS: ChannelMapping[] = [
  // #agency-ops is mapped to Agency / Internal for capture, as in production.
  map('C_AGENCY', 'agency-internal'),
  // Marketing has a channel of its own for capture; its tasks still go to
  // #agency-ops on Monday.
  map('C_MARKETING', 'marketing'),
  map('C_FINANCE', 'finances'),
  map('C_JWB', 'joy-within-birth'),
  map('C_YOGA', 'yoga-farm'),
];

const spacesOf = (plan: ReturnType<typeof planBriefings>, name: string) =>
  findBriefing(plan, name)?.spaces.map((s) => s.slug);

describe('where each Space is briefed', () => {
  const plan = planBriefings(SPACES, MAPPINGS, config);

  it('sends only Inbox, Agency / Internal, Marketing and Sales to #agency-ops', () => {
    expect(spacesOf(plan, 'agency'))
      .toEqual(['inbox', 'agency-internal', 'marketing', 'sales']);
    expect(findBriefing(plan, 'agency')!.channelId).toBe('C_AGENCY');
  });

  it('sends Personal and Music to #personal-ops', () => {
    expect(spacesOf(plan, 'personal')).toEqual(['personal', 'music']);
    expect(findBriefing(plan, 'personal')!.channelId).toBe('C_PERSONAL');
  });

  it('adds a Spiritual Space to #personal-ops once one exists', () => {
    const withSpiritual = planBriefings(
      [...SPACES, space('Spiritual', 'spiritual')], MAPPINGS, config
    );
    expect(spacesOf(withSpiritual, 'personal')).toEqual(['personal', 'music', 'spiritual']);
  });

  it('sends Finances only to the channel mapped to it', () => {
    const finance = findBriefing(plan, 'finances')!;
    expect(finance.channelId).toBe('C_FINANCE');
    expect(finance.spaces.map((s) => s.slug)).toEqual(['finances']);
  });

  it('gives every client its own briefing, in its own mapped channel', () => {
    expect(findBriefing(plan, 'joy-within-birth')).toMatchObject({
      channelId: 'C_JWB', kind: 'space',
    });
    expect(spacesOf(plan, 'joy-within-birth')).toEqual(['joy-within-birth']);
    expect(findBriefing(plan, 'yoga-farm')!.channelId).toBe('C_YOGA');
    expect(spacesOf(plan, 'yoga-farm')).toEqual(['yoga-farm']);
  });

  it('puts every Space in at most one briefing', () => {
    const seen = plan.briefings.flatMap((b) => b.spaces.map((s) => s.id));
    expect(new Set(seen).size).toBe(seen.length);
    // ...and every Space is either briefed or reported, never lost silently.
    expect(seen.length + plan.unrouted.length).toBe(SPACES.length);
  });

  it('never sends the same channel two briefings', () => {
    const channels = plan.briefings.map((b) => b.channelId);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('does not let a capture mapping pull Marketing out of #agency-ops', () => {
    expect(plan.briefings.some((b) => b.channelId === 'C_MARKETING')).toBe(false);
  });

  it('keeps client, finance and music work out of #agency-ops', () => {
    const agency = spacesOf(plan, 'agency')!;
    for (const slug of ['finances', 'music', 'personal', 'joy-within-birth', 'yoga-farm']) {
      expect(agency).not.toContain(slug);
    }
  });

  it('keeps finance and client work out of #personal-ops', () => {
    const personal = spacesOf(plan, 'personal')!;
    for (const slug of ['finances', 'joy-within-birth', 'yoga-farm', 'marketing']) {
      expect(personal).not.toContain(slug);
    }
  });
});

describe('Spaces that cannot be routed safely', () => {
  it('folds a Space with no mapped channel into the Agency briefing', () => {
    const plan = planBriefings(SPACES, MAPPINGS.filter((m) => m.channelId !== 'C_YOGA'), config);
    expect(findBriefing(plan, 'yoga-farm')).toBeNull();
    expect(plan.unrouted).toEqual([]);
    expect(spacesOf(plan, 'agency')).toContain('yoga-farm');
  });

  it('never infers a channel from a matching channel name', () => {
    // A mapping is the only route. A channel CALLED #client-yoga-farm with no
    // row in channel_space_map does not exist as far as routing is concerned.
    const plan = planBriefings(SPACES, [], config);
    expect(plan.briefings.map((b) => b.name)).toEqual(['agency', 'personal']);
    expect(plan.unrouted).toEqual([]);
  });

  it('refuses a Space mapped to two channels rather than posting twice', () => {
    const plan = planBriefings(
      SPACES, [...MAPPINGS, map('C_JWB_2', 'joy-within-birth')], config
    );
    expect(findBriefing(plan, 'joy-within-birth')).toBeNull();
    expect(plan.unrouted[0]).toMatchObject({
      space: { slug: 'joy-within-birth' },
      reason: expect.stringContaining('2 Slack channels'),
    });
  });

  it('briefs a client mapped to #agency-ops in the Agency post, not a second one', () => {
    const plan = planBriefings(
      SPACES,
      [
        ...MAPPINGS.filter((m) => m.channelId !== 'C_AGENCY' && m.channelId !== 'C_YOGA'),
        map('C_AGENCY', 'yoga-farm'),
      ],
      config
    );
    expect(findBriefing(plan, 'yoga-farm')).toBeNull();
    expect(plan.unrouted).toEqual([]);
    expect(spacesOf(plan, 'agency')).toContain('yoga-farm');
    expect(plan.briefings.filter((b) => b.channelId === 'C_AGENCY')).toHaveLength(1);
  });

  it('refuses Finances mapped to #personal-ops', () => {
    const plan = planBriefings(
      SPACES,
      [...MAPPINGS.filter((m) => m.channelId !== 'C_FINANCE'), map('C_PERSONAL', 'finances')],
      config
    );
    expect(findBriefing(plan, 'finances')).toBeNull();
    expect(plan.unrouted[0]!.reason).toContain('Personal briefing channel');
  });
});

describe('the briefings themselves', () => {
  const plan = planBriefings(SPACES, MAPPINGS, config);

  it('lists Agency, then Personal, then each mapped Space in Space order', () => {
    expect(plan.briefings.map((b) => b.name)).toEqual([
      'agency', 'personal', 'finances', 'joy-within-birth', 'yoga-farm',
    ]);
  });

  it('keys a mapped Space by id, so a rename cannot re-deliver a week', () => {
    expect(findBriefing(plan, 'finances')!.ledgerKey).toBe('weekly:space:id-finances');
    expect(findBriefing(plan, 'agency')!.ledgerKey).toBe('weekly:agency');
  });

  it('strips the Daily Anchors from Personal only', () => {
    expect(plan.briefings.filter((b) => b.excludeDailyAnchors).map((b) => b.name))
      .toEqual(['personal']);
  });

  it('keeps the fixed briefings posting when empty, and client channels quiet', () => {
    expect(findBriefing(plan, 'agency')!.postWhenEmpty).toBe(true);
    expect(findBriefing(plan, 'personal')!.postWhenEmpty).toBe(true);
    expect(findBriefing(plan, 'yoga-farm')!.postWhenEmpty).toBe(false);
  });

  it('leaves a fixed briefing with no channel in the plan, to be skipped and said', () => {
    const unset = planBriefings(SPACES, MAPPINGS, { ...config, personalChannelId: '' });
    expect(findBriefing(unset, 'personal')!.channelId).toBeNull();
  });
});

describe('configuration', () => {
  it('defaults the groups to marketing/sales/agency and personal/music/spiritual', () => {
    const c = loadSchedulerConfig({} as NodeJS.ProcessEnv);
    expect(c.agencySpaceKeys).toEqual(['agency-internal', 'marketing', 'sales']);
    expect(c.personalSpaceKeys).toEqual(['personal', 'music', 'spiritual']);
    expect(c.topPerSpace).toBe(10);
  });

  it('can be narrowed, e.g. to move Personal out once Spiritual exists', () => {
    const c = loadSchedulerConfig({
      SCHEDULED_PERSONAL_SPACES: 'music, spiritual',
      SCHEDULED_TOP_PER_SPACE: '5',
    } as unknown as NodeJS.ProcessEnv);
    expect(c.personalSpaceKeys).toEqual(['music', 'spiritual']);
    expect(c.topPerSpace).toBe(5);
  });

  it('ignores a nonsense cap rather than showing nothing', () => {
    for (const raw of ['0', '-3', 'ten', '2.5']) {
      expect(loadSchedulerConfig({ SCHEDULED_TOP_PER_SPACE: raw } as never).topPerSpace)
        .toBe(10);
    }
  });
});
