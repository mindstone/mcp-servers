import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pandadocFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import type { TemplateListResponse } from '../types.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'PandaDoc API key not configured',
    resolution: 'To use PandaDoc, you need to configure an API key first.',
    next_step: {
      action: 'Ask the user for their PandaDoc API key, then call configure_pandadoc_api_key',
      tool_to_call: 'configure_pandadoc_api_key',
      tool_parameters: { api_key: '<user_provided_key>' },
      get_key_from: 'PandaDoc Settings → API → Developer Dashboard. Requires Business or Enterprise plan.',
    },
  });
}

function paginationHint(count: number, page: number, pageSize: number): string {
  if (count < pageSize) return `Showing all ${count} results.`;
  return `Showing ${count} results (page ${page}). Use page=${page + 1} to see more.`;
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
      annotations: { readOnlyHint: true },
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

      const templates = (result.results || []).map((t) => ({
        id: t.id,
        name: t.name,
        date_created: t.date_created,
        date_modified: t.date_modified,
        version: t.version,
      }));

      const hint = paginationHint(templates.length, args.page, args.count);
      return JSON.stringify({ ok: true, templates, count: templates.length, pagination: hint });
    }),
  );
}
