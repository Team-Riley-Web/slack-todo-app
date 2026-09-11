import 'dotenv/config';
import { App as BoltApp } from '@slack/bolt';
import { createDb, migrate } from '@tr/db';
import { registerSlackHandlers } from './app.js';
import { loadConfig } from './config.js';
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

const app = new BoltApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  ...(config.mode === 'socket'
    ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
    : { socketMode: false }),
});
registerSlackHandlers(app, { db, config });

// Housekeeping: dedupe rows outlive their usefulness within seconds.
startRetentionSweep(db, retentionDays());

if (config.mode === 'socket') {
  await app.start();
} else {
  await app.start(Number(process.env.PORT ?? 3000));
}
console.log(`[slack] running in ${config.mode} mode`);
