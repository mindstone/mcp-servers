import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsBinaryDownload, elevenLabsJson } from '../client.js';
import { ENDPOINTS, ELEVENLABS_API_V1_BASE } from '../endpoints.js';
import { historyResponseSchema, parseApiResponse } from '../api-schemas.js';
import { ElevenLabsError } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';

export function registerHistoryTools(server: McpServer): void {
  server.registerTool(
    'list_history',
    {
      description: `List previously generated audio items (speech, sound effects, etc.) on this account.

WHEN TO USE:
- Find a past generation to re-use ("that voiceover from last week") instead of regenerating
- Review what text/voice/model a previous generation used

EXAMPLE: {"page_size": 10}

RELATED TOOLS:
- get_history_item_audio: re-download the audio of an item from this list
- get_usage_stats: aggregate credit spend instead of individual items
- generate_speech: create a new generation

RETURNS: items[] with history_item_id, date, model, source, enveloped text and voice_name; plus has_more and last_history_item_id for pagination.

COST: FREE — read only.`,
      inputSchema: z.object({
        page_size: z.number().int().min(1).max(1000).optional().describe('Items per page (1-1000). Default: 25.'),
        start_after_history_item_id: z.string().optional().describe('Cursor from a previous response (last_history_item_id) to fetch the next page.'),
        voice_id: z.string().optional().describe('Only items generated with this voice_id.'),
        search: z.string().optional().describe('Case-insensitive substring match against the generated text.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
        );
      }

      const params = new URLSearchParams({ page_size: String(args.page_size ?? 25) });
      if (args.start_after_history_item_id) {
        params.set('start_after_history_item_id', args.start_after_history_item_id);
      }
      if (args.voice_id) params.set('voice_id', args.voice_id);
      if (args.search) params.set('search', args.search);

      const data = parseApiResponse(
        historyResponseSchema,
        await elevenLabsJson<unknown>(
          apiKey,
          `${ELEVENLABS_API_V1_BASE}${ENDPOINTS.HISTORY}?${params.toString()}`,
        ),
        'history',
      );

      // text and voice_name are external content (the spoken text is whatever
      // was generated, possibly from an injected prompt) — envelope both
      // (AGENTS.md invariant #6). model_id, source, and content_type are
      // API-authored strings too; they are expected to be enum-like but are
      // not validated against a closed grammar, so they are enveloped as well.
      const items = data.history.map((item) => ({
        history_item_id: item.history_item_id,
        date_unix: item.date_unix,
        date_iso: item.date_unix ? new Date(item.date_unix * 1000).toISOString() : undefined,
        model_id: wrapUntrusted(item.model_id, 'elevenlabs:list_history:model_id'),
        source: wrapUntrusted(item.source, 'elevenlabs:list_history:source'),
        voice_id: item.voice_id,
        voice_name: wrapUntrusted(item.voice_name, 'elevenlabs:list_history:voice_name'),
        content_type: wrapUntrusted(item.content_type, 'elevenlabs:list_history:content_type'),
        characters_used:
          item.character_count_change_from != null && item.character_count_change_to != null
            ? item.character_count_change_to - item.character_count_change_from
            : undefined,
        text: wrapUntrusted(item.text, 'elevenlabs:list_history:text'),
      }));

      return JSON.stringify({
        ok: true,
        items,
        count: items.length,
        has_more: data.has_more ?? false,
        last_history_item_id: data.last_history_item_id,
        cost: 'FREE — read only',
        message:
          `Found ${items.length} history item${items.length === 1 ? '' : 's'}` +
          (data.has_more ? '; pass last_history_item_id as start_after_history_item_id for the next page.' : '.'),
      });
    }),
  );

  server.registerTool(
    'get_history_item_audio',
    {
      description: `Re-download the audio of a past generation by history_item_id.

WHEN TO USE:
- After list_history — fetch the audio file of an earlier generation again
- Recover audio that was generated in a previous session

EXAMPLE: {"history_item_id": "ja9xsmfGhxYcymxGcOGB"}

RELATED TOOLS:
- list_history: find history_item_id values

RETURNS: file_path and size_bytes (extension sniffed from Content-Type).

COST: FREE — download only (credits were charged at generation time).`,
      inputSchema: z.object({
        history_item_id: z.string().min(1).describe('History item ID from list_history.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
        );
      }

      let audio;
      try {
        audio = await elevenLabsBinaryDownload(apiKey, ENDPOINTS.historyAudio(args.history_item_id));
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'HTTP_404') {
          throw new ElevenLabsError(
            `History item not found: ${args.history_item_id}`,
            'HISTORY_ITEM_NOT_FOUND',
            'Verify the history_item_id with list_history. Items may be deleted by retention settings.',
          );
        }
        throw error;
      }

      return JSON.stringify({
        ok: true,
        file_path: audio.filePath,
        size_bytes: audio.sizeBytes,
        history_item_id: args.history_item_id,
        cost: 'FREE — download only',
        message: `History audio saved to ${audio.filePath} (${audio.sizeBytes} bytes).`,
      });
    }),
  );
}
