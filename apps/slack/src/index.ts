import 'dotenv/config';
import Bolt from '@slack/bolt';
import { createDb, migrate } from '@tr/db';
import { CHECKBOX_ACTION_ID, WAITING_ACTION_ID } from '@tr/slack-ui';
import { loadConfig } from './config.js';
import { handleCheckboxToggle } from './handlers/checkbox.js';
import { handleWaitingAction } from './handlers/waiting.js';
import { handleTaskCommand } from './handlers/task-command.js';
import { handleTasksCommand } from './handlers/tasks-command.js';

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

app.action(WAITING_ACTION_ID, async ({ ack, body, client }) => {
  await ack();
  await handleWaitingAction({ db, client: client as never, config }, body as never);
});

app.error(async (error) => {
  console.error('[slack] unhandled error', error);
});

if (config.mode === 'socket') {
  await app.start();
} else {
  await app.start(Number(process.env.PORT ?? 3000));
}
console.log(`[slack] running in ${config.mode} mode`);
