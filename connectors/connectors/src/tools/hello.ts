import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withErrorHandling } from '../utils.js';

export function registerHelloTools(server: McpServer): void {
  server.registerTool(
    'humaans_hello_world',
    {
      description:
        'Returns a simple greeting. Use this to verify the Humaans connector is reachable and responding.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    withErrorHandling(async () => {
      return JSON.stringify({ ok: true, message: 'Hello from Humaans MCP!' });
    }),
  );
}
