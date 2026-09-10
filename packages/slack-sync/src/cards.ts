import type { Db } from '@tr/db';
import type { CardEntry } from '@tr/slack-ui';

export interface SavedCard {
  task_ids: string[];
  rendered_state: Record<string, boolean>;
  /** version -> the state that version was rendered with. Last few kept. */
  rendered_versions: Record<string, Record<string, boolean>>;
  version: number;
  view_scope: string | null;
}

/** How many past renders stay diffable. Beyond this a payload is too old. */
export const RETAINED_RENDER_VERSIONS = 5;

/**
 * Records exactly what was drawn, at a specific version, so a later toggle can
 * be diffed against the render its client actually saw rather than the newest
 * one. Diffing against the newest made a second user's stale payload look like
 * a deliberate uncheck and silently reverted the first user's completion.
 */
export async function saveCard(
  db: Db,
  args: {
    channelId: string;
    messageTs: string;
    entries: CardEntry[];
    viewScope?: string | null;
    version?: number;
  }
): Promise<void> {
  const taskIds = args.entries.map((e) => e.task.id);
  const rendered: Record<string, boolean> = {};
  for (const e of args.entries) rendered[e.task.id] = e.task.status === 'completed';

  const version = args.version ?? 1;
  const existing = await loadCard(db, args.channelId, args.messageTs);
  const history: Record<string, Record<string, boolean>> = {
    ...(existing?.rendered_versions ?? {}),
    [String(version)]: rendered,
  };
  // Keep only the most recent versions so the column cannot grow without bound.
  const trimmed = Object.fromEntries(
    Object.entries(history)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .slice(0, RETAINED_RENDER_VERSIONS)
  );

  await db.query(
    `INSERT INTO slack_cards
       (channel_id, message_ts, task_ids, rendered_state, view_scope, version, rendered_versions)
     VALUES ($1, $2, $3::uuid[], $4::jsonb, $5, $6, $7::jsonb)
     ON CONFLICT (channel_id, message_ts) DO UPDATE
       SET task_ids = EXCLUDED.task_ids,
           rendered_state = EXCLUDED.rendered_state,
           view_scope = EXCLUDED.view_scope,
           version = EXCLUDED.version,
           rendered_versions = EXCLUDED.rendered_versions,
           updated_at = now()`,
    [
      args.channelId, args.messageTs,
      `{${taskIds.join(',')}}`,
      JSON.stringify(rendered),
      args.viewScope ?? null,
      version,
      JSON.stringify(trimmed),
    ]
  );
}

/**
 * The state a payload should be diffed against: the render its block_id names,
 * falling back to the latest render when that version is unknown (a card from
 * before versioning, or older than the retained window).
 */
export function baselineFor(
  card: SavedCard, payloadVersion: number | null
): { state: Record<string, boolean>; matched: boolean } {
  if (payloadVersion !== null) {
    const historical = card.rendered_versions[String(payloadVersion)];
    if (historical) return { state: historical, matched: true };
  }
  return { state: card.rendered_state, matched: false };
}

export async function loadCard(
  db: Db, channelId: string, messageTs: string
): Promise<SavedCard | null> {
  const { rows } = await db.query<SavedCard>(
    `SELECT task_ids, rendered_state, rendered_versions, version, view_scope
       FROM slack_cards WHERE channel_id = $1 AND message_ts = $2`,
    [channelId, messageTs]
  );
  const row = rows[0];
  if (!row) return null;
  const parse = <T>(value: unknown, fallback: T): T =>
    typeof value === 'string' ? (JSON.parse(value) as T) : ((value ?? fallback) as T);
  return {
    task_ids: Array.isArray(row.task_ids) ? row.task_ids : [],
    rendered_state: parse(row.rendered_state, {} as Record<string, boolean>),
    rendered_versions: parse(row.rendered_versions, {} as Record<string, Record<string, boolean>>),
    version: Number(row.version ?? 1),
    view_scope: row.view_scope ?? null,
  };
}

/**
 * Returns false when this exact interaction was already processed.
 *
 * An absent action_ts cannot identify an interaction, so it is treated as fresh
 * rather than deduped. Deduping on a blank key would collapse every later
 * toggle on that message into one "duplicate" and silently swallow real clicks
 * — a far worse failure than the duplicate audit row a missed dedupe can cause,
 * since transitions are idempotent by construction and task state stays correct
 * either way.
 */
export async function claimInteraction(
  db: Db, channelId: string, messageTs: string, actionTs: string
): Promise<boolean> {
  if (!actionTs) return true;
  const { rows } = await db.query(
    `INSERT INTO processed_interactions (channel_id, message_ts, action_ts)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING channel_id`,
    [channelId, messageTs, actionTs]
  );
  return rows.length > 0;
}
