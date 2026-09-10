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
  handleImportCommand, handleUploadSubmit, handleMappingSubmit,
  handlePreviewSubmit, handleWizardClosed, type ImportDeps,
} from './handlers/import-wizard.js';
import { makeFetchFile } from './slack-file.js';
import { retentionDays, startRetentionSweep } from './retention.js';

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
