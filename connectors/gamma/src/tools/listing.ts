import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, hasApiKey } from '../auth.js';
import { listThemes, listFolders } from '../client.js';
import { GammaError } from '../types.js';
import { withErrorHandling } from '../utils.js';

function requireApiKey(): string {
  if (!hasApiKey()) {
    throw new GammaError(
      'Gamma API key not configured',
      'AUTH_REQUIRED',
      'The user adds the Gamma API key in Settings → Connectors in the app. Do not ask for it in chat. Get it from https://gamma.app/settings/developers.',
    );
  }
  return getApiKey();
}

export function registerListingTools(server: McpServer): void {
  // ── gamma_list_themes ──────────────────────────────────────────

  server.registerTool(
    'gamma_list_themes',
    {
      description:
        'List available Gamma themes. Call this FIRST when user wants to apply corporate/custom branding. ' +
        'type: "custom" = workspace themes (corporate branding), type: "standard" = global themes. ' +
        'Use the "id" field when calling gamma_generate with theme_id parameter. ' +
        'Pagination: if has_more is true, pass next_cursor as the "after" parameter.',
      inputSchema: z.object({
        query: z.string().optional().describe('Search themes by name'),
        limit: z.number().optional().describe('Results per page (default 50, max 50)'),
        after: z.string().optional().describe('Pagination cursor from previous response'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await listThemes(apiKey, {
        query: args.query,
        limit: args.limit,
        after: args.after,
      });
      return JSON.stringify(
        {
          themes: result.data,
          has_more: result.hasMore,
          next_cursor: result.nextCursor,
        },
        null,
        2,
      );
    }),
  );

  // ── gamma_list_folders ─────────────────────────────────────────

  server.registerTool(
    'gamma_list_folders',
    {
      description:
        'List folders in the user\'s Gamma workspace for organizing presentations. ' +
        'Use folder "id" in gamma_generate\'s folder_ids parameter. ' +
        'Pagination: if has_more is true, pass next_cursor as the "after" parameter.',
      inputSchema: z.object({
        query: z.string().optional().describe('Search folders by name'),
        limit: z.number().optional().describe('Results per page (default 50, max 50)'),
        after: z.string().optional().describe('Pagination cursor from previous response'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await listFolders(apiKey, {
        query: args.query,
        limit: args.limit,
        after: args.after,
      });
      return JSON.stringify(
        {
          folders: result.data,
          has_more: result.hasMore,
          next_cursor: result.nextCursor,
        },
        null,
        2,
      );
    }),
  );
}
