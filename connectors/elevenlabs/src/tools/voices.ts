import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson } from '../client.js';
import { ElevenLabsError, type VoicesResponse } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerVoiceTools(server: McpServer): void {
  server.registerTool(
    'list_voices',
    {
      description:
        'Search and browse available ElevenLabs voices. FREE — no credits consumed. ' +
        'Returns voice ID, name, description, category, preview URL, and labels. ' +
        'Use voice_id from results with generate_speech.',
      inputSchema: z.object({
        search: z.string().optional().describe('Search query to filter voices by name.'),
        category: z.enum(['premade', 'cloned', 'generated', 'professional']).optional()
          .describe('Filter by voice category.'),
        page_size: z.number().int().min(1).max(100).optional().describe('Number of results (1-100). Default: 20.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'Ask the user for their API key, then call configure_elevenlabs_api_key.',
        );
      }

      const params = new URLSearchParams();
      if (args.search) params.set('search', args.search);
      if (args.category) params.set('category', args.category);
      params.set('page_size', String(Math.min(100, args.page_size ?? 20)));

      const data = await elevenLabsJson<VoicesResponse>(
        apiKey,
        `https://api.elevenlabs.io/v2/voices?${params.toString()}`,
      );

      const voices = data.voices.map((v) => ({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category,
        description: v.description,
        labels: v.labels,
        preview_url: v.preview_url,
      }));

      return JSON.stringify({
        ok: true,
        voices,
        count: voices.length,
        has_more: data.has_more || false,
        cost: 'FREE — no credits consumed',
        message: `Found ${voices.length} voice${voices.length === 1 ? '' : 's'}${args.search ? ` matching "${args.search}"` : ''}.`,
        hint: 'Use voice_id with generate_speech to create audio with a specific voice.',
      });
    }),
  );
}
