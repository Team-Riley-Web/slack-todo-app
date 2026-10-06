import { parseAssigneeLabels } from '@tr/task-core';
import { SCHEDULE_ZONE } from './schedule.js';

export interface SchedulerConfig {
  timeZone: string;
  /** Where the Agency briefing goes (#agency-ops). */
  agencyChannelId: string;
  /** Where the Personal briefing goes (#personal-ops). */
  personalChannelId: string;
  /**
   * Space slugs or names that make up the Agency briefing. Inbox is always
   * included on top of these, by its `is_inbox` flag rather than by name.
   */
  agencySpaceKeys: string[];
  /** Space slugs or names that make up the Personal briefing. */
  personalSpaceKeys: string[];
  /**
   * How many tasks each Space shows before the rest are summarized as a
   * count. Priority order decides which make the cut.
   */
  topPerSpace: number;
  assigneeLabels: Record<string, string>;
}

/** Marketing, sales and agency operations. Inbox joins them by flag. */
export const DEFAULT_AGENCY_SPACES = ['agency-internal', 'marketing', 'sales'];

/**
 * Personal, Music and Spiritual. The app has no "spiritual" category inside
 * Personal -- spiritual work lives in the Personal Space today -- so Personal
 * is the spiritual bucket until a Spiritual Space exists, at which point it
 * joins automatically by slug.
 */
export const DEFAULT_PERSONAL_SPACES = ['personal', 'music', 'spiritual'];

export const DEFAULT_TOP_PER_SPACE = 10;

function list(raw: string | undefined, fallback: string[]): string[] {
  const parsed = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * The two fixed destinations are named outright. Every other briefing goes to
 * the channel its Space is mapped to in `channel_space_map` -- the same
 * mapping `/space` and `/map` maintain -- so a new client channel gets its
 * briefing with no change here.
 */
export function loadSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env
): SchedulerConfig {
  return {
    timeZone: env.DEFAULT_TIMEZONE?.trim() || SCHEDULE_ZONE,
    agencyChannelId: env.SCHEDULED_AGENCY_CHANNEL_ID?.trim() ?? '',
    personalChannelId: env.SCHEDULED_PERSONAL_CHANNEL_ID?.trim() ?? '',
    agencySpaceKeys: list(env.SCHEDULED_AGENCY_SPACES, DEFAULT_AGENCY_SPACES),
    personalSpaceKeys: list(env.SCHEDULED_PERSONAL_SPACES, DEFAULT_PERSONAL_SPACES),
    topPerSpace: positiveInt(env.SCHEDULED_TOP_PER_SPACE, DEFAULT_TOP_PER_SPACE),
    assigneeLabels: parseAssigneeLabels(env.ASSIGNEE_LABELS),
  };
}
