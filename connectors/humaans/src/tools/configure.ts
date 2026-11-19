import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ADD_TOKEN_IN_SETTINGS, isConfigured, TOKEN_SCOPES, TOKEN_URL } from '../auth.js';
import { withErrorHandling } from '../utils.js';

// Keeps its name because hosts name it as the connector's setup tool, but it
// takes no token: the key is set only by the host, never through the chat.
export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_humaans_api_key',
    {
      description:
        'Check whether the Humaans connector has an API token, and get setup instructions if it does not. ' +
        'This tool takes no token. The person adds the Humaans API token in the app\'s Settings → Connectors ' +
        '(or, in an MCP host without connector settings, the HUMAANS_API_KEY environment variable), never in chat: ' +
        'do not ask for the token or accept it in the conversation. ' +
        `A token comes from ${TOKEN_URL}: click "Generate new token", name it (e.g., "MCP Server") ` +
        `and select the scopes ${TOKEN_SCOPES}.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    withErrorHandling(async () => {
      if (isConfigured()) {
        return JSON.stringify({
          ok: true,
          configured: true,
          message: 'A Humaans API token is set. You can use list_humaans_people to browse the team.',
        });
      }
      return JSON.stringify({
        ok: true,
        configured: false,
        message: 'No Humaans API token is set yet.',
        next_step: {
          action: ADD_TOKEN_IN_SETTINGS,
          get_key_from: TOKEN_URL,
          scopes: TOKEN_SCOPES,
        },
      });
    }),
  );
}
