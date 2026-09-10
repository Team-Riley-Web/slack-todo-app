import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createDb, migrate } from '@tr/db';
import { syncChannelMap, listChannelMap } from '@tr/task-core';

const path = process.env.CHANNEL_MAP_PATH ?? 'config/channel-map.json';
const prune = process.argv.includes('--prune');

const db = await createDb();
await migrate(db);

let raw: string;
try {
  raw = await readFile(path, 'utf8');
} catch {
  console.error(
    `No channel map at ${path}.\n` +
    `Copy config/channel-map.example.json to ${path} and fill in real Slack channel IDs,\n` +
    `or set CHANNEL_MAP_PATH to another location.`
  );
  process.exit(1);
}
const config = JSON.parse(raw);
const result = await syncChannelMap(db, config, { prune });

console.log(`channel map: ${result.upserted} upserted, ${result.pruned} pruned (from ${path})`);
for (const c of await listChannelMap(db)) {
  console.log(`  ${(c.channelName ?? c.channelId).padEnd(30)} -> ${c.spaceName}`);
}
await db.close();
