import 'dotenv/config';
import { createDb, migrate } from '@tr/db';
import { pruneProcessedInteractions, retentionDays } from '../apps/slack/src/retention.js';

const db = await createDb();
await migrate(db);
const days = retentionDays();
const removed = await pruneProcessedInteractions(db, days);
const { rows } = await db.query<{ n: number }>(
  `SELECT COUNT(*)::int AS n FROM processed_interactions`
);
console.log(`pruned ${removed} interaction(s) older than ${days} days; ${rows[0]!.n} remain`);
await db.close();
