import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDb, migrate } from '@tr/db';
import { buildTools } from './tools.js';

const db = await createDb();
await migrate(db);
const tools = buildTools(db);
const byName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: 'team-riley-tasks', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = byName.get(req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());
