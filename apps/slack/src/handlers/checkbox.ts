import type { Db } from '@tr/db';
import {
  completeTask, getTask, reopenTask, listSpaces,
  InvalidTaskIdError, TaskNotFoundError, type Space, type Task,
} from '@tr/task-core';
import {
  parseBlockVersion, taskCardBlocks, taskCardFallback, type CardEntry,
} from '@tr/slack-ui';
import { authorize } from '../auth.js';
import {
  baselineFor, claimInteraction, loadCard, redrawCard, withCardLock,
  type CardDeps,
} from '@tr/slack-sync';
import type { AppConfig } from '../config.js';

export interface CheckboxDeps {
  db: Db;
  client: { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } };
  config: AppConfig;
}

export type ToggleOutcome =
  | 'applied' | 'noop' | 'duplicate' | 'unauthorized' | 'unknown_card';

interface SelectedOption { value?: string }

/**
 * The docs are inconsistent about where checkbox selections live: the state
 * payload documents `selected_options`, while the checkboxes reference example
 * shows `options`. Read the documented location first, then fall back.
 * An empty array is a genuine deselect-all and must not be read as absence.
 */
export function readSelectedValues(
  body: Record<string, any>, blockId: string, actionId: string
): string[] {
  const fromState = body?.state?.values?.[blockId]?.[actionId]?.selected_options;
  const action = (body?.actions ?? []).find(
    (a: Record<string, unknown>) => a.action_id === actionId
  );
  const chosen: SelectedOption[] | undefined =
    fromState ?? action?.selected_options ?? action?.options;
  if (!Array.isArray(chosen)) return [];
  return chosen.map((o) => o?.value).filter((v): v is string => typeof v === 'string');
}

export interface CheckboxState {
  /**
   * Every task drawn as an option in the element that was clicked, or null
   * when the payload carried no message body to read them from.
   */
  rendered: Set<string> | null;
  /** Every task currently ticked in that same element. */
  selected: Set<string>;
}

/**
 * Reads the state of the ONE checkbox element that was clicked, and nothing
 * else in the message.
 *
 * Slack caps a checkboxes element at 10 options, so a card of any size is
 * several elements, and a click reports the ticks in its own element only.
 * Diffing every task on the card against that one element read each
 * completed task in the other elements as unticked and reopened it — six
 * checks on the morning digest left one task completed (2026-09-13).
 *
 * The other elements cannot be read from the payload either. `state.values`
 * does carry an entry for each of them, but for an element the user has not
 * touched it does NOT reflect `initial_options`: a tick in the INBOX element
 * arrived with the MUSIC element's ticks reported as empty, and reopened the
 * completed task rendered there (2026-09-13 13:44:40Z). So the rule is that a
 * click may only change the element it landed in. That loses nothing — an
 * untick anywhere else arrives as its own click on its own element.
 *
 * `message.blocks` gives the clicked element's full option list, which is the
 * exact set this interaction is entitled to report on.
 */
export function readCheckboxState(
  body: Record<string, any>, clickedBlockId: string, actionId: string
): CheckboxState {
  const selected = new Set(readSelectedValues(body, clickedBlockId, actionId));

  const blocks: unknown = body?.message?.blocks;
  if (!Array.isArray(blocks)) return { rendered: null, selected };

  const block = (blocks as Record<string, any>[]).find((b) => b?.block_id === clickedBlockId);
  const element = (block?.elements ?? []).find(
    (e: Record<string, unknown>) => e?.type === 'checkboxes' && e?.action_id === actionId
  );
  if (!element) return { rendered: null, selected };

  const rendered = new Set<string>();
  for (const option of (element.options ?? []) as SelectedOption[]) {
    if (typeof option?.value === 'string') rendered.add(option.value);
  }
  return { rendered, selected };
}

export async function handleCheckboxToggle(
  deps: CheckboxDeps, body: Record<string, any>
): Promise<{ outcome: ToggleOutcome }> {
  const { db, config } = deps;

  const auth = authorize(body as never, config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const action = (body.actions ?? [])[0];
  const channelId: string | undefined = body.container?.channel_id ?? body.channel?.id;
  const messageTs: string | undefined = body.container?.message_ts;
  const blockId: string = action?.block_id ?? '';
  const actionId: string = action?.action_id ?? '';
  if (!channelId || !messageTs) return { outcome: 'unknown_card' };

  return withCardLock(`${channelId}:${messageTs}`, async () => {
    const card = await loadCard(db, channelId, messageTs);
    if (!card) return { outcome: 'unknown_card' as ToggleOutcome };

    const fresh = await claimInteraction(db, channelId, messageTs, action?.action_ts ?? '');

    const { rendered, selected } = readCheckboxState(body, blockId, actionId);
    const actor = { id: auth.userId, source: 'slack' };
    let applied = false;

    // Diff against the render THIS client saw, named by its block_id version.
    // Against the newest render instead, a second user's stale payload reads as
    // a deliberate uncheck and silently reverts the first user's completion.
    const { state: baseline } = baselineFor(card, parseBlockVersion(blockId));

    // A task outside the clicked element is not "unticked" — this interaction
    // says nothing about it. Without a message body only the ticks themselves
    // are known, so only completions can apply.
    const accounted = (taskId: string): boolean =>
      rendered ? rendered.has(taskId) : selected.has(taskId);

    const completed: string[] = [];
    const reopened: string[] = [];
    if (fresh) {
      for (const taskId of card.task_ids) {
        if (!accounted(taskId)) continue;
        const wasRendered = baseline[taskId] === true;
        const nowSelected = selected.has(taskId);
        if (wasRendered === nowSelected) continue; // this checkbox did not move
        try {
          if (nowSelected) await completeTask(db, taskId, actor);
          else await reopenTask(db, taskId, actor);
          (nowSelected ? completed : reopened).push(taskId);
          applied = true;
        } catch (err) {
          if (!(err instanceof InvalidTaskIdError) && !(err instanceof TaskNotFoundError)) throw err;
        }
      }
    }

    // One line per toggle, so an unexpected reopen leaves evidence of what the
    // payload said rather than only what the database did.
    console.log(
      `[checkbox] ${channelId}/${messageTs} block=${blockId} fresh=${fresh} ` +
      `rendered=${rendered ? rendered.size : 'none'} selected=${selected.size} ` +
      `completed=[${completed.join(',')}] reopened=[${reopened.join(',')}]`
    );

    await redrawCard(deps, channelId, messageTs, card.task_ids, card.view_scope ?? null);

    if (!fresh) return { outcome: 'duplicate' as ToggleOutcome };
    return { outcome: (applied ? 'applied' : 'noop') as ToggleOutcome };
  });
}
