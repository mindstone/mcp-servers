import { createRequire } from 'node:module';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'canary-mcp-server',
    version: pkg.version,
  });

  server.registerTool(
    'ping',
    {
      description:
        'Echo a message back wrapped as "pong: <message>". Used to verify the canary connector is reachable and the release pipeline produced a working build.',
      inputSchema: z.object({
        message: z
          .string()
          .min(1)
          .max(200)
          .describe('A short message to echo back. 1-200 chars.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => {
      const message = (args as { message: string }).message;
      return {
        content: [
          {
            type: 'text',
            text: `pong: ${message}`,
          },
        ],
      };
    },
  );

  return server;
}
