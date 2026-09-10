import 'dotenv/config';
import Bolt from '@slack/bolt';
import { createDb, migrate } from '@tr/db';
import {
  CHECKBOX_ACTION_ID, WAITING_ACTION_ID, EDIT_CALLBACK_ID,
  IMPORT_CALLBACK_IDS,
} from '@tr/slack-ui';
import { loadConfig } from './config.js';
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
import { retentionDays, startRetentionSweep } from './retention.js';
import { acquireLock } from './single-instance.js';

/**
 * One instance only. Socket Mode splits events between every connected
 * process, so a forgotten instance serves a share of traffic with stale code
 * instead of failing -- see single-instance.ts.
 */
const LOCK_PATH = process.env.SLACK_LOCK_PATH?.trim() || '.slack.pid';
const lock = await acquireLock(LOCK_PATH);
if (!lock.acquired) {
  console.error(
    `[slack] another instance is already running (pid ${lock.heldBy}).\n` +
    '        Socket Mode would split events between them, so this one is ' +
    'refusing to start.\n' +
    `        Stop it first:  kill ${lock.heldBy}`
  );
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void lock.release().finally(() => process.exit(0));
  });
}

const config = loadConfig();
const db = await createDb();
await migrate(db);

const app = new Bolt.App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  ...(config.mode === 'socket'
    ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
    : { socketMode: false }),
});

app.command('/task', async ({ command, ack, client }) => {
  await ack();
  await handleTaskCommand({ db, client: client as never, config }, command as never);
});

app.command('/tasks', async ({ command, ack, client }) => {
  await ack();
  await handleTasksCommand({ db, client: client as never, config }, command as never);
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
  fetchFile: makeFetchFile(
    client as never, process.env.SLACK_BOT_TOKEN ?? ''
  ),
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

app.error(async (error) => {
  console.error('[slack] unhandled error', error);
});

// Housekeeping: dedupe rows outlive their usefulness within seconds.
startRetentionSweep(db, retentionDays());

if (config.mode === 'socket') {
  await app.start();
} else {
  await app.start(Number(process.env.PORT ?? 3000));
}
console.log(`[slack] running in ${config.mode} mode`);
