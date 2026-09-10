import 'dotenv/config';
import { createDb, migrate } from '@tr/db';
import { buildServer } from './server.js';

const db = await createDb();
await migrate(db);

const app = buildServer({ db, apiToken: process.env.API_TOKEN?.trim() || null });
await app.listen({ port: Number(process.env.API_PORT ?? 3030), host: '0.0.0.0' });
console.log(`[api] listening on ${process.env.API_PORT ?? 3030}`);
