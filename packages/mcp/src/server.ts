import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '@tr/db';
import { buildTools } from './tools.js';

export const MCP_SERVER_INFO = {
  name: 'team-riley-tasks',
  version: '0.1.0',
} as const;

/**
 * The MCP server itself, with no transport attached.
 *
 * Both transports call this and nothing else, so the tool list, the argument
 * handling and the response shape are physically the same code on stdio and
 * over HTTPS. A tool cannot exist on one and not the other, and neither can a
 * bug fix -- which is the whole reason this was lifted out of `index.ts`.
 */
export function createMcpServer(db: Db): Server {
  const tools = buildTools(db);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
    const result = await tool.handler(
      (req.params.arguments ?? {}) as Record<string, unknown>
    );
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}
