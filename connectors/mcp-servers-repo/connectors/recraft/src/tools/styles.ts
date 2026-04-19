import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { recraftFetch } from '../client.js';
import { resolveImageInput, buildMultipartForm } from '../files.js';
import { isConfigured } from '../auth.js';
import { withErrorHandling } from '../utils.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Recraft API key not configured',
    resolution: 'To use Recraft, you need to configure an API key first.',
    next_step: {
      action: 'Ask the user for their Recraft API key, then call configure_recraft_api_key',
      tool_to_call: 'configure_recraft_api_key',
      tool_parameters: { api_key: '<user_provided_key>' },
      get_key_from: 'https://app.recraft.ai/profile/api',
    },
  });
}

export function registerStylesTools(server: McpServer): void {
  server.registerTool(
    'recraft_list_styles',
    {
      description: 'List available Recraft styles or custom styles visible to the API key.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(25).describe('Maximum number of styles to return'),
      }),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();
      const response = await recraftFetch<unknown>(`/styles?limit=${args.limit}`);
      return JSON.stringify({ ok: true, styles: response });
    }),
  );

  server.registerTool(
    'recraft__create_style',
    {
      description: 'Create a style in Recraft from reference images.',
      inputSchema: z.object({
        style: z.enum(['any', 'realistic_image', 'digital_illustration', 'vector_illustration', 'icon']),
        imageURIs: z.array(z.string()).min(1).max(5).describe('Public URLs or file:// paths for style references'),
      }),
      annotations: { readOnlyHint: false },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();
      const form = await buildMultipartForm(
        { style: args.style },
        await Promise.all(args.imageURIs.map(async (input, index) => ({ fieldName: `file${index + 1}`, input }))),
      );
      const response = await recraftFetch<unknown>('/styles', {
        method: 'POST',
        body: form,
      });
      const resolvedImages = await Promise.all(args.imageURIs.map((uri) => resolveImageInput(uri)));
      return JSON.stringify({
        ok: true,
        result: response,
        uploadedReferences: resolvedImages.map((item) => ({ filename: item.filename, source: item.source })),
      });
    }),
  );
}
