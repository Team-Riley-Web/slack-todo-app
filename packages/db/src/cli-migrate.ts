import { createDb } from './client.js';
import { migrate } from './migrate.js';

const db = await createDb();
await migrate(db);
await db.close();
console.log('migrations applied');
