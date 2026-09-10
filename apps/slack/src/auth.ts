export interface AuthConfig { teamId: string; authorizedUserIds: string[] }
export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; reason: string };

interface AuthLikeBody {
  team?: { id?: string } | null;
  user?: { id?: string } | null;
}

/** Runs before any database write. A rejection performs zero mutation. */
export function authorize(body: AuthLikeBody, config: AuthConfig): AuthResult {
  const userId = body.user?.id;
  if (!userId) return { ok: false, reason: 'no_user' };

  // Fail closed: an unconfigured team id rejects everything rather than
  // accepting every workspace.
  if (!config.teamId) return { ok: false, reason: 'unconfigured_team' };
  if (body.team?.id !== config.teamId) return { ok: false, reason: 'wrong_workspace' };

  if (config.authorizedUserIds.length > 0 && !config.authorizedUserIds.includes(userId)) {
    return { ok: false, reason: 'not_allowlisted' };
  }
  return { ok: true, userId };
}
