import type { Db } from '@tr/db';
import { createSpace } from '@tr/task-core';
import { authorize } from '../auth.js';
import type { AppConfig } from '../config.js';
import type { SlashCommandLike } from './task-command.js';
import { replyPrivately, type Respond } from '../reply.js';

/**
 * `/tasks new <name>` — create a Space, and nothing else.
 *
 * The gap this fills: the only other way to create a Space in Slack was the
 * `/task` capture modal's "…or a new Space" field, which also creates a task.
 * A new client often needs the Space set up before there is a first thing to
 * do in it, and forcing a placeholder task to get one is backwards.
 *
 * A subcommand of `/tasks` rather than a new slash command, so it needs no
 * change to the Slack app's configuration and no reinstall.
 */

export interface SpaceDeps {
  db: Db;
  /** Reaches the user even in a channel this app has not joined. */
  respond?: Respond;
  client: {
    chat: { postEphemeral: (args: Record<string, unknown>) => Promise<unknown> };
  };
  config: AppConfig;
}

export type NewSpaceOutcome =
  | 'created' | 'existed' | 'invalid' | 'unauthorized';

/**
 * The Space name in `new <name>`, or null when this is not that command.
 *
 * Requires a name after the word, so a bare `/tasks new` is not treated as a
 * creation with an empty name — and so a Space that happened to be called
 * "new" could still be searched for with `/tasks new`. A test asserts no
 * seeded Space carries that name.
 */
export function parseNewSpaceCommand(text: string | undefined | null): string | null {
  const match = /^new\s+(.+)$/i.exec((text ?? '').trim());
  return match ? match[1]!.trim() : null;
}

export async function handleNewSpaceCommand(
  deps: SpaceDeps, command: SlashCommandLike, name: string
): Promise<{ outcome: NewSpaceOutcome }> {
  const auth = authorize(
    { team: { id: command.team_id }, user: { id: command.user_id } } as never,
    deps.config
  );
  if (!auth.ok) return { outcome: 'unauthorized' };

  const result = await createSpace(deps.db, name);

  /*
   * This used to be a bare `catch {}` around postEphemeral, with the comment
   * "a failed confirmation must not undo a Space that already exists". True,
   * but it turned every failure into total silence: in a channel the app had
   * not been invited to, `/space` created the Space and said nothing, so it
   * looked like the command had done nothing at all. replyPrivately keeps the
   * never-throw property and adds a response_url path, which needs no channel
   * membership, plus a log if even that fails.
   */
  const tell = (text: string): Promise<void> =>
    replyPrivately(
      deps, { channelId: command.channel_id, userId: command.user_id }, text
    );

  if (!result.ok || !result.space) {
    await tell(result.error ?? 'Could not create that Space.');
    return { outcome: 'invalid' };
  }

  if (result.existed) {
    await tell(
      `*${result.space.name}* already exists, so nothing changed. ` +
      `Map a channel to it with \`/tasks map\`.`
    );
    return { outcome: 'existed' };
  }

  await tell(
    `Created the Space *${result.space.name}*. ` +
    `Capture into it with \`/tasks map\` in its channel, or pick it in \`/task\`.`
  );
  return { outcome: 'created' };
}
