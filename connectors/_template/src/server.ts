import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from './utils.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'CONNECTOR_NAME-mcp-server',
    version: pkg.version,
  });

  // --- Example tool: configure credentials ---
  server.registerTool(
    'configure_CONNECTOR_NAME_api_key',
    {
      description: 'Configure the API key for CONNECTOR_NAME',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('API key for authentication'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      // TODO: Implement credential storage (env, config file, or bridge)
      return JSON.stringify({
        ok: true,
        message: 'API key configured successfully',
      });
    }),
  );

  // --- Example tool: list resources ---
  server.registerTool(
    'list_CONNECTOR_NAME_resources',
    {
      description: 'List resources from CONNECTOR_NAME',
      inputSchema: z.object({
        limit: z.number().min(1).max(100).default(25).describe('Maximum number of results'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      // TODO: Replace with real API call
      return JSON.stringify({
        ok: true,
        resources: [],
        total: 0,
      });
    }),
  );

  return server;
}
