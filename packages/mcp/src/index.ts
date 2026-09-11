import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDb, migrate } from '@tr/db';
import { createMcpServer } from './server.js';

/**
 * The stdio transport — `pnpm mcp`. Unchanged in behaviour: the same tools,
 * the same responses. Only the construction moved into `server.ts` so the
 * HTTP transport can share it rather than reimplement it.
 */
const db = await createDb();
await migrate(db);
await createMcpServer(db).connect(new StdioServerTransport());
