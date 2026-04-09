import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from './utils.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'CONNECTOR_NAME-mcp-server',
    version: '0.1.0',
  });

  // --- Example tool: configure credentials ---
  server.registerTool(
    'configure_CONNECTOR_NAME_api_key',
    {
      description: 'Configure the API key for CONNECTOR_NAME',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('API key for authentication'),
      }),
      annotations: { destructiveHint: false, readOnlyHint: false },
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
      annotations: { readOnlyHint: true },
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
