import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pandadocFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { sanitizeContact, sanitizeFolder, sanitizeList } from '../sanitize.js';
import type { FolderListResponse, ContactListResponse } from '../types.js';

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

export function registerDiscoveryTools(server: McpServer): void {
  // ── list_document_folders ───────────────────────────────────────────
  server.registerTool(
    'list_document_folders',
    {
      description:
        `List PandaDoc document folders.

Returns folder UUIDs and names. Use a folder's uuid as the folder_uuid input of
create_document_from_template, upload_document, create_document_from_url, or the
list_documents/list_templates filters.

NOTE: the root folder is not listed by the API. Pass a folder's uuid as
parent_uuid to list its subfolders; omit parent_uuid to list top-level folders.

RELATED TOOLS:
- list_documents: Filter documents by folder_uuid
- list_templates: Filter templates by folder_uuid`,
      inputSchema: z.object({
        parent_uuid: z.string().optional().describe('UUID of the parent folder. Omit to list top-level folders.'),
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
      if (args.parent_uuid) params.set('parent_uuid', args.parent_uuid);

      const result = await pandadocFetch<FolderListResponse>(
        `/documents/folders?${params.toString()}`,
      );

      const folders = sanitizeList(
        result.results || [],
        sanitizeFolder,
        'pandadoc:list_document_folders',
      ) as Array<Record<string, unknown>>;
      const hint = paginationHint(folders.length, args.page, args.count);

      return JSON.stringify({ ok: true, folders, count: folders.length, pagination: hint });
    }),
  );

  // ── list_contacts ───────────────────────────────────────────────────
  server.registerTool(
    'list_contacts',
    {
      description:
        `List contacts in the PandaDoc workspace.

Returns contact ids, names, emails, companies, and other stored details.
Use this to discover existing recipients before creating or sending documents.
Supports count/page paging; use the pagination hint in the response to page
through large workspaces.

RELATED TOOLS:
- create_document_from_template: Reference discovered contacts as recipients
- send_document: Send a document to discovered recipients`,
      inputSchema: z.object({
        email: z.string().optional().describe('Filter by exact email match'),
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
      if (args.email) params.set('email', args.email);
      const queryStr = params.toString();

      const result = await pandadocFetch<ContactListResponse>(
        `/contacts?${queryStr}`,
      );

      const contacts = sanitizeList(
        result.results || [],
        sanitizeContact,
        'pandadoc:list_contacts',
      ) as Array<Record<string, unknown>>;
      const hint = paginationHint(contacts.length, args.page, args.count);

      return JSON.stringify({ ok: true, contacts, count: contacts.length, pagination: hint });
    }),
  );
}
