import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pandadocFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { sanitizeTemplate } from '../sanitize.js';
import type { TemplateListResponse } from '../types.js';

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
  // The PandaDoc list API returns only `results` — no totals or next-page
  // markers — so a page's length cannot prove completeness. Never claim
  // "all results", and never promise another page exists.
  if (count < pageSize) {
    return `Showing ${count} results (page ${page}). This page is not full, so there are probably no further pages; the API does not report totals.`;
  }
  return `Showing ${count} results (page ${page}). This page is full, so more results may exist — try page=${page + 1}. The API does not report totals.`;
}

export function registerTemplateTools(server: McpServer): void {
  server.registerTool(
    'list_templates',
    {
      description:
        `List available PandaDoc templates.

Returns template IDs, names, and dates. Use template IDs with create_document_from_template.

RELATED TOOLS:
- create_document_from_template: Use a template ID to create a new document`,
      inputSchema: z.object({
        q: z.string().optional().describe('Search by template name'),
        folder_uuid: z.string().optional().describe('Filter by folder ID'),
        tag: z.array(z.string()).optional().describe('Filter by tags'),
        count: z.number().min(1).max(100).default(50).describe('Results per page (default 50, max 100)'),
        page: z.number().min(1).default(1).describe('Page number (starts at 1)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const params = new URLSearchParams();
      params.set('count', String(args.count));
      params.set('page', String(args.page));

      if (args.q) params.set('q', args.q);
      if (args.folder_uuid) params.set('folder_uuid', args.folder_uuid);
      if (args.tag && Array.isArray(args.tag)) {
        for (const t of args.tag) {
          params.append('tag', t);
        }
      }

      const result = await pandadocFetch<TemplateListResponse>(
        `/templates?${params.toString()}`,
      );

      const templates = (result.results || []).map((t) =>
        sanitizeTemplate(
          {
            id: t.id,
            name: t.name,
            date_created: t.date_created,
            date_modified: t.date_modified,
            version: t.version,
          },
          'pandadoc:list_templates',
        ),
      );

      const hint = paginationHint(templates.length, args.page, args.count);
      return JSON.stringify({ ok: true, templates, count: templates.length, pagination: hint });
    }),
  );
}
