import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey } from '../auth.js';
import { opusFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';

interface OpusSuccessResponse<T> {
  data?: T;
}

interface CollectionDto {
  collectionId?: string;
  collectionName?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface CollectionExportedDto {
  contentList?: Array<{ contentId?: string; uriForExport?: string }>;
}

export function registerCollectionTools(server: McpServer): void {
  // ── opus_create_collection ────────────────────────────────────────

  server.registerTool(
    'opus_create_collection',
    {
      description:
        'Create a new clip collection to organise your clips. ' +
        'Returns the new collectionId. Use opus_add_clip_to_collection to populate it.',
      inputSchema: z.object({
        collectionName: z.string().min(1).describe('Display name for the collection.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<OpusSuccessResponse<CollectionDto>>('/api/collections', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      const collection = result.data ?? ({} as CollectionDto);
      return JSON.stringify(
        {
          ok: true,
          collectionId: collection.collectionId,
          collectionName: collection.collectionName,
          collection,
        },
        null,
        2,
      );
    }),
  );

  // ── opus_get_collections ──────────────────────────────────────────

  server.registerTool(
    'opus_get_collections',
    {
      description:
        'List your OpusClip collections. ' +
        'Use `q: "mine"` to list all collections on your account, or `q: "findByContentId"` (with `contentId` set to a full clip id like "{projectId}.{curationId}") to find which collections contain a specific clip.',
      inputSchema: z
        .object({
          q: z.enum(['mine', 'findByContentId']).default('mine'),
          contentId: z.string().optional(),
        })
        .refine((v) => v.q !== 'findByContentId' || !!v.contentId, {
          message: 'contentId is required when q="findByContentId".',
        }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const params = new URLSearchParams();
      params.set('q', args.q);
      if (args.contentId) params.set('contentId', args.contentId);

      const result = await opusFetch<
        OpusSuccessResponse<{
          list?: CollectionDto[];
          total?: number;
          next?: string | number | null;
          limit?: number | null;
        }>
      >(`/api/collections?${params.toString()}`);

      const data = result.data ?? {};
      return JSON.stringify(
        {
          ok: true,
          count: data.list?.length ?? 0,
          total: data.total,
          next: data.next,
          collections: data.list ?? [],
        },
        null,
        2,
      );
    }),
  );

  // ── opus_export_collection ────────────────────────────────────────

  server.registerTool(
    'opus_export_collection',
    {
      description:
        'Export all clips from a collection. Returns a `contentList` of `{ contentId, uriForExport }` pairs — the uriForExport URLs are Google Cloud Storage download links for the clip MP4s.',
      inputSchema: z.object({
        collectionId: z.string().min(1),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<OpusSuccessResponse<CollectionExportedDto>>(
        `/api/collections/${encodeURIComponent(args.collectionId)}/export`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      const data = result.data ?? {};
      return JSON.stringify(
        {
          ok: true,
          collectionId: args.collectionId,
          count: data.contentList?.length ?? 0,
          contentList: data.contentList ?? [],
        },
        null,
        2,
      );
    }),
  );

  // ── opus_delete_collection ────────────────────────────────────────

  server.registerTool(
    'opus_delete_collection',
    {
      description:
        'Delete a clip collection. ' +
        'IMPORTANT: only the collection container is deleted — the clips themselves are preserved and still accessible via opus_get_clips with `q: "findByProjectId"`.',
      inputSchema: z.object({
        collectionId: z.string().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<OpusSuccessResponse<string>>(
        `/api/collections/${encodeURIComponent(args.collectionId)}`,
        { method: 'DELETE' },
      );
      return JSON.stringify(
        {
          ok: true,
          deletedCollectionId: result.data ?? args.collectionId,
        },
        null,
        2,
      );
    }),
  );
}
