import { parseAssigneeLabels, PERSONAL_SPACE_SLUG } from '@tr/task-core';
import { SCHEDULE_ZONE } from './schedule.js';

export interface SchedulerConfig {
  timeZone: string;
  /** Where the Agency digest and every EOS reminder go. */
  agencyChannelId: string;
  /** Where the Personal digest goes. */
  personalChannelId: string;
  /** Space slugs or names that count as Personal. Everything else is Agency. */
  personalSpaceKeys: string[];
  assigneeLabels: Record<string, string>;
}

function list(raw: string | undefined, fallback: string[]): string[] {
  const parsed = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * Channel ids are configuration, not lookups.
 *
 * They could be derived from `config/channel-map.json`, but that map answers a
 * different question -- which Space a task captured in this channel belongs to
 * -- and the Personal digest has no channel in it at all. Naming the two
 * destinations outright means a scheduled post cannot start going somewhere
 * else because someone remapped a channel for capture.
 */
export function loadSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env
): SchedulerConfig {
  return {
    timeZone: env.DEFAULT_TIMEZONE?.trim() || SCHEDULE_ZONE,
    agencyChannelId: env.SCHEDULED_AGENCY_CHANNEL_ID?.trim() ?? '',
    personalChannelId: env.SCHEDULED_PERSONAL_CHANNEL_ID?.trim() ?? '',
    personalSpaceKeys: list(env.SCHEDULED_PERSONAL_SPACES, [PERSONAL_SPACE_SLUG]),
    assigneeLabels: parseAssigneeLabels(env.ASSIGNEE_LABELS),
  };
}

/**
 * The channel a job needs, or null when it is not configured.
 *
 * A job with no destination is skipped and SAID SO rather than throwing: an
 * unset Personal channel should not take the Agency digest down with it.
 */
export function channelFor(
  config: SchedulerConfig, job: 'personal-daily' | string
): string | null {
  const id = job === 'personal-daily' ? config.personalChannelId : config.agencyChannelId;
  return id || null;
}
