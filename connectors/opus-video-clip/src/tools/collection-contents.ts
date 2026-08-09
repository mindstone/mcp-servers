import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey } from '../auth.js';
import { opusFetch } from '../client.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';

interface OpusSuccessResponse<T> {
  data?: T;
}

interface CollectionContentDto {
  collectionId?: string;
  contentId?: string;
}

export function registerCollectionContentTools(server: McpServer): void {
  // ── opus_add_clip_to_collection ───────────────────────────────────

  server.registerTool(
    'opus_add_clip_to_collection',
    {
      description:
        'Add a clip to an existing collection. ' +
        '`contentId` is the full clip ID in the form `{projectId}.{curationId}` (e.g. "Q20107035eDq.CU0b92e6") — get it from opus_get_clips.',
      inputSchema: z.object({
        collectionId: z.string().min(1),
        contentId: z
          .string()
          .min(1)
          .describe('Full clip id in the form `{projectId}.{curationId}`.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<OpusSuccessResponse<CollectionContentDto>>(
        '/api/collection-contents',
        {
          method: 'POST',
          body: JSON.stringify(args),
        },
      );
      return JSON.stringify(
        {
          ok: true,
          collectionId: result.data?.collectionId ?? args.collectionId,
          contentId: result.data?.contentId ?? args.contentId,
        },
        null,
        2,
      );
    }),
  );

  // ── opus_remove_clip_from_collection ──────────────────────────────

  server.registerTool(
    'opus_remove_clip_from_collection',
    {
      description:
        'Remove a clip from a collection. ' +
        'IMPORTANT: Opus exposes this operation as a POST to /api/collection-contents/delete-collection-contents (NOT a DELETE). ' +
        'The clip itself is not deleted — only the collection membership is removed.',
      inputSchema: z.object({
        collectionId: z.string().min(1),
        contentId: z.string().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      // Opus requires the `q` selector to be present inside the JSON body
      // (not the query string) — otherwise the API returns
      // `InvalidParam: q must be one of the following values`.
      const result = await opusFetch<OpusSuccessResponse<string>>(
        '/api/collection-contents/delete-collection-contents',
        {
          method: 'POST',
          body: JSON.stringify({ q: 'findByCollectionIdAndContentId', ...args }),
        },
      );
      return JSON.stringify(
        {
          ok: true,
          // The upstream status string is external text — envelop it
          // (invariant #6) rather than returning it raw.
          status: wrapUntrusted(result.data, 'opus:remove_clip_from_collection:status') ?? 'success',
          collectionId: args.collectionId,
          contentId: args.contentId,
        },
        null,
        2,
      );
    }),
  );
}
