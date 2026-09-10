import type { Db } from '@tr/db';
import type { CardEntry } from '@tr/slack-ui';

export interface SavedCard {
  task_ids: string[];
  rendered_state: Record<string, boolean>;
  view_scope: string | null;
}

/** Records exactly what was drawn, so a later toggle can be diffed against it. */
export async function saveCard(
  db: Db,
  args: { channelId: string; messageTs: string; entries: CardEntry[]; viewScope?: string | null }
): Promise<void> {
  const taskIds = args.entries.map((e) => e.task.id);
  const rendered: Record<string, boolean> = {};
  for (const e of args.entries) rendered[e.task.id] = e.task.status === 'completed';

  await db.query(
    `INSERT INTO slack_cards (channel_id, message_ts, task_ids, rendered_state, view_scope)
     VALUES ($1, $2, $3::uuid[], $4::jsonb, $5)
     ON CONFLICT (channel_id, message_ts) DO UPDATE
       SET task_ids = EXCLUDED.task_ids,
           rendered_state = EXCLUDED.rendered_state,
           view_scope = EXCLUDED.view_scope,
           updated_at = now()`,
    [
      args.channelId, args.messageTs,
      `{${taskIds.join(',')}}`,
      JSON.stringify(rendered),
      args.viewScope ?? null,
    ]
  );
}

export async function loadCard(
  db: Db, channelId: string, messageTs: string
): Promise<SavedCard | null> {
  const { rows } = await db.query<SavedCard>(
    `SELECT task_ids, rendered_state, view_scope FROM slack_cards
      WHERE channel_id = $1 AND message_ts = $2`,
    [channelId, messageTs]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    task_ids: Array.isArray(row.task_ids) ? row.task_ids : [],
    rendered_state:
      typeof row.rendered_state === 'string'
        ? JSON.parse(row.rendered_state)
        : (row.rendered_state ?? {}),
    view_scope: row.view_scope ?? null,
  };
}

/** Returns false when this exact interaction was already processed. */
export async function claimInteraction(
  db: Db, channelId: string, messageTs: string, actionTs: string
): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO processed_interactions (channel_id, message_ts, action_ts)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING channel_id`,
    [channelId, messageTs, actionTs]
  );
  return rows.length > 0;
}
