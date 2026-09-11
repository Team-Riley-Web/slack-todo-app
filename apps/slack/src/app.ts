import type { App } from '@slack/bolt';
import type { Db } from '@tr/db';
import {
  CHECKBOX_ACTION_ID, WAITING_ACTION_ID, EDIT_CALLBACK_ID,
  IMPORT_CALLBACK_IDS,
} from '@tr/slack-ui';
import type { AppConfig } from './config.js';
import { handleCheckboxToggle } from './handlers/checkbox.js';
import { handleWaitingAction } from './handlers/waiting.js';
import { handleTaskCommand } from './handlers/task-command.js';
import { handleTasksCommand } from './handlers/tasks-command.js';
import { handleEditOpen, handleEditSubmission } from './handlers/edit-modal.js';
import {
  handleTaskShortcut, handlePickerSubmission,
  SHORTCUT_IDS, PICKER_CALLBACK_ID, type ShortcutDeps,
} from './handlers/shortcuts.js';
import {
  handleImportCommand, handleUploadSubmit, handleMappingSubmit,
  handlePreviewSubmit, handleWizardClosed, type ImportDeps,
} from './handlers/import-wizard.js';
import { makeFetchFile } from './slack-file.js';
import {
  handleMapCommand, handleMapSubmission, MAP_CALLBACK_ID,
} from './handlers/map-command.js';
import {
  handleCaptureSubmission, CAPTURE_CALLBACK_ID,
} from './handlers/capture-modal.js';

export interface SlackHandlerDeps {
  db: Db;
  config: AppConfig;
  env?: NodeJS.ProcessEnv;
}

/**
 * Registers the same Slack behavior on any Bolt receiver.
 *
 * Local development supplies Bolt's Socket Mode receiver. Production supplies
 * the Vercel HTTP receiver, so hosting changes cannot make the two paths drift.
 */
export function registerSlackHandlers(
  app: App,
  { db, config, env = process.env }: SlackHandlerDeps
): void {
  app.command('/task', async ({ command, ack, client, respond }) => {
    await ack();
    // `respond` posts to the command's response_url, which works in a channel
    // this app has not been invited to. postEphemeral does not, and a command
    // whose reply silently fails looks like a command that did nothing.
    await handleTaskCommand(
      { db, client: client as never, respond, config }, command as never
    );
  });

  /**
   * `/space` — pick this channel's Space, create one, or unmap, in one modal.
   *
   * Its own command rather than `/task space`, so the byte-exact title rule
   * stays absolute: a subcommand would mean nobody could have a task called
   * exactly "space".
   */
  app.command('/space', async ({ command, ack, client, respond }) => {
    await ack();
    await handleMapCommand(
      { db, client: client as never, respond, config }, command as never
    );
  });

  app.command('/tasks', async ({ command, ack, client, respond }) => {
    await ack();
    await handleTasksCommand(
      { db, client: client as never, respond, config }, command as never
    );
  });

  // The native checkbox is the single task-state control, in both directions.
  app.action(CHECKBOX_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    await handleCheckboxToggle({ db, client: client as never, config }, body as never);
  });

  /**
   * Kept for cards posted before the controls moved into Slack's "More actions"
   * menu. Those messages still carry an overflow, and it should keep working
   * rather than silently doing nothing.
   *
   * One overflow carries two kinds of value, so dispatch on the prefix rather
   * than calling both handlers and letting one no-op. `edit:` must reach
   * handleEditOpen promptly: the trigger_id it needs expires in 3 seconds.
   */
  app.action(WAITING_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    const value: string =
      (body as Record<string, any>).actions?.[0]?.selected_option?.value ?? '';
    const deps = { db, client: client as never, config };
    if (value.startsWith('edit:')) {
      await handleEditOpen(deps, body as never);
      return;
    }
    await handleWaitingAction(deps, body as never);
  });

  /**
   * Task actions in Slack's own message ⋮ menu, as message shortcuts.
   *
   * A shortcut targets a message, not a task, so a card holding several tasks
   * gets a picker first. Both must reach views.open quickly: the trigger_id
   * expires 3 seconds after Slack sends it.
   */
  const shortcutDeps = (client: unknown): ShortcutDeps =>
    ({ db, client: client as never, config });

  app.shortcut(
    { callback_id: SHORTCUT_IDS.edit, type: 'message_action' } as never,
    (async ({ ack, body, client }: Record<string, any>) => {
      await ack();
      await handleTaskShortcut(shortcutDeps(client), 'edit', body);
    }) as never
  );

  app.shortcut(
    { callback_id: SHORTCUT_IDS.waiting, type: 'message_action' } as never,
    (async ({ ack, body, client }: Record<string, any>) => {
      await ack();
      await handleTaskShortcut(shortcutDeps(client), 'waiting', body);
    }) as never
  );

  // The picker's submit. Choosing a task to edit pushes the edit modal on top,
  // so Back returns to the list instead of dropping out of the flow.
  app.view(PICKER_CALLBACK_ID, async ({ ack, body, client, view }) => {
    const result = await handlePickerSubmission(
      shortcutDeps(client),
      { ...(body as unknown as Record<string, unknown>), view } as never
    );
    if (result.view) {
      await ack({ response_action: 'push', view: result.view } as never);
      return;
    }
    await ack();
  });

  // Modal submit. Validation errors are returned to the modal natively via
  // response_action rather than failing silently.
  app.view(EDIT_CALLBACK_ID, async ({ ack, body, client, view }) => {
    const result = await handleEditSubmission(
      { db, client: client as never, config },
      { ...(body as unknown as Record<string, unknown>), view } as never
    );
    if (result.outcome === 'invalid' && result.error) {
      await ack({
        response_action: 'errors',
        errors: { [result.error.blockId]: result.error.message },
      } as never);
      return;
    }
    await ack();
  });

  /**
   * The import wizard.
   *
   * Each step acks immediately and then finishes its work, because Slack drops a
   * view_submission that is not acknowledged within 3 seconds and staging a
   * large file does not fit in that budget. The continuation runs after ack and
   * updates the view when it is done.
   */
  const importDeps = (client: unknown): ImportDeps => ({
    db,
    client: client as never,
    config,
    fetchFile: makeFetchFile(client as never, env.SLACK_BOT_TOKEN ?? ''),
  });

  app.command('/import', async ({ command, ack, client }) => {
    await ack();
    await handleImportCommand(importDeps(client), command as never);
  });

  const wizardStep = (
    handler: (deps: ImportDeps, body: Record<string, any>) => {
      ack: Record<string, unknown> | undefined;
      after?: () => Promise<void>;
    }
  ) => async ({ ack, body, client, view }: Record<string, any>) => {
    const deps = importDeps(client);
    const result = handler(deps, { ...body, view });
    await ack(result.ack as never);
    // After the ack, so a slow import cannot cost us the 3-second window.
    if (result.after) {
      try {
        await result.after();
      } catch (error) {
        console.error('[slack] import wizard step failed after ack', error);
      }
    }
  };

  app.view(IMPORT_CALLBACK_IDS.upload, wizardStep(handleUploadSubmit) as never);
  app.view(IMPORT_CALLBACK_IDS.mapping, wizardStep(handleMappingSubmit) as never);
  app.view(IMPORT_CALLBACK_IDS.preview, wizardStep(handlePreviewSubmit) as never);

  // An abandoned wizard marks its batch ABORTED instead of leaving it staged.
  for (const id of [
    IMPORT_CALLBACK_IDS.upload, IMPORT_CALLBACK_IDS.mapping,
    IMPORT_CALLBACK_IDS.preview, IMPORT_CALLBACK_IDS.working,
  ]) {
    app.view({ callback_id: id, type: 'view_closed' }, wizardStep(handleWizardClosed) as never);
  }

  /**
   * `/tasks map` submit. A bad Space is returned as a native field error so the
   * modal stays open with the choice still in it.
   */
  app.view(MAP_CALLBACK_ID, async ({ ack, body, client, view }) => {
    const result = await handleMapSubmission(
      { db, client: client as never, config },
      { ...(body as unknown as Record<string, unknown>), view } as never
    );
    if (result.outcome === 'invalid' && result.error) {
      await ack({
        response_action: 'errors',
        errors: { [result.error.blockId]: result.error.message },
      } as never);
      return;
    }
    await ack();
  });

  /**
   * The bare-`/task` capture modal's submit. A field problem comes back as a
   * native error so the modal stays open with everything typed still in it.
   */
  app.view(CAPTURE_CALLBACK_ID, async ({ ack, body, client, view }) => {
    const result = await handleCaptureSubmission(
      { db, client: client as never, config },
      { ...(body as unknown as Record<string, unknown>), view } as never
    );
    if (result.error) {
      await ack({
        response_action: 'errors',
        errors: { [result.error.blockId]: result.error.message },
      } as never);
      return;
    }
    await ack();
  });

  app.error(async (error) => {
    console.error('[slack] unhandled error', error);
  });
}
