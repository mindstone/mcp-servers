import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch, runwayRawFetch } from '../client.js';
import { wrapUntrusted } from '../untrusted-content.js';
import type { VoicePreviewResponse } from '../types.js';
import { RunwayError } from '../types.js';
import { withErrorHandling } from '../utils.js';

/**
 * External-response schema for GET /v1/voices. `name` and `description` are
 * authored in the external system (by the user, or by whoever created the
 * voice), so they are attacker-controllable text and must be enveloped before
 * they reach model-visible output (invariant #6).
 */
const voiceItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  createdAt: z.string(),
  status: z.string(),
});

const voiceListResponseSchema = z.object({
  data: z.array(voiceItemSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullish(),
});

export function registerVoiceTools(server: McpServer): void {
  // ── List Custom Voices ────────────────────────────────────────────────
  server.registerTool(
    'list_custom_voices',
    {
      description:
        'List all custom voices you\'ve created. Returns voice IDs, names, descriptions, and status. ' +
        'Use the voice ID with generate_speech.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      const raw = await runwayFetch<unknown>('/voices');
      const result = voiceListResponseSchema.parse(raw);
      const voices = result.data.map(v => ({
        id: v.id,
        name: wrapUntrusted(v.name, 'runway-voice'),
        description: wrapUntrusted(v.description || '', 'runway-voice'),
        status: v.status, created: v.createdAt,
      }));
      return JSON.stringify({
        ok: true, voices, count: voices.length, has_more: result.hasMore,
        message: voices.length === 0
          ? 'No custom voices yet. Create one with create_custom_voice.'
          : `Found ${voices.length} custom voice(s).`,
      });
    }),
  );

  // ── Create Custom Voice ───────────────────────────────────────────────
  server.registerTool(
    'create_custom_voice',
    {
      description:
        'Create a custom voice from a text description of desired voice characteristics. ' +
        'MODELS: eleven_multilingual_ttv_v2 (default), eleven_ttv_v3 (newer). ' +
        'Check status with list_custom_voices. Once READY, use its ID with generate_speech.',
      inputSchema: z.object({
        name: z.string().describe('Name for the voice. Max 100 characters.'),
        prompt: z.string().describe('Text description of desired voice. Min 20, max 1000 characters.'),
        model: z.enum(['eleven_multilingual_ttv_v2', 'eleven_ttv_v3']).optional().describe('Voice design model. Default: eleven_multilingual_ttv_v2.'),
        description: z.string().optional().describe('Optional description for your reference. Max 512 characters.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const model = args.model || 'eleven_multilingual_ttv_v2';
      const body: Record<string, unknown> = {
        name: args.name,
        from: { type: 'text', prompt: args.prompt, model },
      };
      if (args.description) body.description = args.description;

      const result = await runwayFetch<{ id: string }>('/voices', { method: 'POST', body: JSON.stringify(body) });
      return JSON.stringify({
        ok: true, voice_id: result.id,
        message: `Custom voice "${args.name}" created (ID: ${result.id}). It may take a few seconds to process. Check status with list_custom_voices.`,
      });
    }),
  );

  // ── Preview Voice ─────────────────────────────────────────────────────
  server.registerTool(
    'preview_voice',
    {
      description:
        'Generate a short audio preview of a voice from a text description, without creating it. ' +
        'Use to audition voice characteristics before committing with create_custom_voice.',
      inputSchema: z.object({
        prompt: z.string().describe('Text description of desired voice. Min 20, max 1000 characters.'),
        model: z.enum(['eleven_multilingual_ttv_v2', 'eleven_ttv_v3']).optional().describe('Voice design model. Default: eleven_multilingual_ttv_v2.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const model = args.model || 'eleven_multilingual_ttv_v2';
      const result = await runwayFetch<VoicePreviewResponse>('/voices/preview', {
        method: 'POST',
        body: JSON.stringify({ prompt: args.prompt, model }),
      });
      return JSON.stringify({
        ok: true, preview_url: result.url, duration_seconds: result.durationSecs,
        message: `Voice preview generated (${result.durationSecs}s). Listen at: ${result.url}`,
      });
    }),
  );

  // ── Delete Custom Voice ───────────────────────────────────────────────
  server.registerTool(
    'delete_custom_voice',
    {
      description: 'Delete a custom voice by ID. This is permanent and cannot be undone.',
      inputSchema: z.object({
        voice_id: z.string().describe('UUID of the voice to delete (from list_custom_voices).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const delRes = await runwayRawFetch(`/voices/${args.voice_id}`, { method: 'DELETE' });
      if (!delRes.ok && delRes.status !== 204) {
        throw new RunwayError(
          `Failed to delete voice (HTTP ${delRes.status})`,
          `HTTP_${delRes.status}`,
          'Check the voice ID and try again.',
        );
      }
      return JSON.stringify({ ok: true, message: `Voice ${args.voice_id} deleted.` });
    }),
  );
}
