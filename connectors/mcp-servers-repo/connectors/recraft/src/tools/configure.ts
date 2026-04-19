import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_recraft_api_key',
    {
      description: 'Configure the Recraft API key',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('API key for Recraft authentication'),
      }),
      annotations: { destructiveHint: false, readOnlyHint: false },
    },
    withErrorHandling(async (args) => {
      setApiKey(args.api_key);
      return JSON.stringify({ ok: true, message: 'Recraft API key configured successfully' });
    }),
  );
}
