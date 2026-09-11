import { parseAssigneeLabels } from '@tr/task-core';

export interface AppConfig {
  teamId: string;
  authorizedUserIds: string[];
  defaultAssigneeId: string | null;
  assigneeLabels: Record<string, string>;
  timeZone: string;
  mode: 'socket' | 'http';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaultAssigneeId = env.DEFAULT_ASSIGNEE_SLACK_ID?.trim() || null;
  // ASSIGNEE_LABELS names everyone; the legacy pair still names the default
  // assignee, and loses to the map if both mention the same id.
  const assigneeLabels: Record<string, string> = {};
  if (defaultAssigneeId && env.DEFAULT_ASSIGNEE_LABEL?.trim()) {
    assigneeLabels[defaultAssigneeId] = env.DEFAULT_ASSIGNEE_LABEL.trim();
  }
  Object.assign(assigneeLabels, parseAssigneeLabels(env.ASSIGNEE_LABELS));
  return {
    teamId: env.SLACK_TEAM_ID?.trim() ?? '',
    authorizedUserIds: (env.AUTHORIZED_SLACK_USER_IDS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    defaultAssigneeId,
    assigneeLabels,
    timeZone: env.DEFAULT_TIMEZONE?.trim() || 'America/Chicago',
    mode: env.SLACK_MODE === 'http' ? 'http' : 'socket',
  };
}
