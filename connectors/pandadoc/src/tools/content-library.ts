import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pandadocFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import {
  sanitizeContentLibraryItem,
  sanitizeContentLibraryItemDetails,
  sanitizeList,
} from '../sanitize.js';
import type { ContentLibraryItemListResponse } from '../types.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'PandaDoc API key not configured',
    resolution: 'To use PandaDoc, you need to configure an API key first.',
    next_step: {
      action: 'The user adds the PandaDoc API key in Settings → Connectors in the app. Do not ask for it in chat.',
      get_key_from: 'PandaDoc Settings → API → Developer Dashboard. Requires Business or Enterprise plan.',
    },
  });
}

function paginationHint(count: number, page: number, pageSize: number): string {
  if (count < pageSize) return `Showing all ${count} results.`;
  return `Showing ${count} results (page ${page}). Use page=${page + 1} to see more.`;
}

export function registerContentLibraryTools(server: McpServer): void {
  // ── list_content_library_items ──────────────────────────────────────
  server.registerTool(
    'list_content_library_items',
    {
      description:
        `List PandaDoc content library items (reusable content blocks).

Content library items are pre-approved blocks (pricing sections, legal clauses,
product descriptions) that teams assemble into templates and documents.
Returns item IDs, names, and dates.

NOTE: the API rejects empty filter values — omit filters you don't need rather
than passing empty strings.

RELATED TOOLS:
- get_content_library_item_details: Inspect an item's fields, tokens, and pricing
- list_templates: List full templates`,
      inputSchema: z.object({
        q: z.string().min(1).optional().describe('Search by content library item name'),
        id: z.string().min(1).optional().describe('Fetch a specific content library item by ID'),
        folder_uuid: z.string().min(1).optional().describe('Filter by content library folder UUID'),
        tag: z.string().min(1).optional().describe('Filter by tag'),
        deleted: z.boolean().optional().describe('If true, return only deleted items. Default: false'),
        count: z.number().min(1).max(100).default(50).describe('Results per page (default 50, max 100)'),
        page: z.number().min(1).default(1).describe('Page number (starts at 1)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      // The PandaDoc API returns 400 when a filter is present but empty —
      // only set params that were actually provided.
      const params = new URLSearchParams();
      params.set('count', String(args.count));
      params.set('page', String(args.page));
      if (args.q) params.set('q', args.q);
      if (args.id) params.set('id', args.id);
      if (args.folder_uuid) params.set('folder_uuid', args.folder_uuid);
      if (args.tag) params.set('tag', args.tag);
      if (args.deleted !== undefined) params.set('deleted', String(args.deleted));

      const result = await pandadocFetch<ContentLibraryItemListResponse>(
        `/content-library-items?${params.toString()}`,
      );

      const items = sanitizeList(
        result.results || [],
        sanitizeContentLibraryItem,
        'pandadoc:list_content_library_items',
      ) as Array<Record<string, unknown>>;
      const hint = paginationHint(items.length, args.page, args.count);

      return JSON.stringify({ ok: true, items, count: items.length, pagination: hint });
    }),
  );

  // ── get_content_library_item_details ────────────────────────────────
  server.registerTool(
    'get_content_library_item_details',
    {
      description:
        `Get full details for a PandaDoc content library item.

Returns roles, fields with values, tokens, pricing tables, metadata, and tags —
everything needed to understand what a reusable block contributes when assembled
into a template or document.

RELATED TOOLS:
- list_content_library_items: Find content library item IDs`,
      inputSchema: z.object({
        content_library_item_id: z.string().min(1).describe('The content library item ID (from list_content_library_items)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const result = await pandadocFetch<Record<string, unknown>>(
        `/content-library-items/${encodeURIComponent(args.content_library_item_id)}/details`,
      );

      return JSON.stringify({
        ok: true,
        item: sanitizeContentLibraryItemDetails(result, 'pandadoc:get_content_library_item_details'),
      });
    }),
  );
}
