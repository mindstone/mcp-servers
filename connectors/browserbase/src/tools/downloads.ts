import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserbaseFetch, browserbaseFetchBytes, requireApiKey } from '../client.js';
import { ConnectorError } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { EPOCH_MS_FIELD_HINT, epochMsField, epochMsToIso } from './common.js';
import { sanitizeDownload, sanitizeList } from '../sanitize.js';

/** Hard cap on files returned inline as base64. Larger files must be fetched
 * from the Browserbase dashboard instead. */
const MAX_INLINE_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export function registerDownloadTools(server: McpServer): void {
  server.registerTool(
    'list_downloads',
    {
      description: `List files that were downloaded inside browser sessions (e.g. an automation clicked a download link), with filters and offset pagination.

WHEN TO USE:
- Find a file an automation downloaded, then fetch it with get_download_file
- Audit what a session downloaded

PAGINATION: offset-based — pass limit + offset; total tells you how many records exist overall.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 400: session_id is required

RELATED TOOLS:
- get_download_info: Metadata for one download
- get_download_file: Fetch the file bytes (small files, as base64)
- delete_download: Remove a download

RETURNS: downloads[] (id, sessionId, filename, mimeType, size, checksum, createdAt), total, limit, offset.`,
      inputSchema: {
        session_id: z.string().min(1)
          .describe('Required. Only downloads from this session ID (from list_sessions).'),
        filename: z.string().max(255).optional()
          .describe('Filter by filename (e.g. "report.pdf").'),
        mime_type: z.string().max(255).optional()
          .describe('Filter by MIME type (e.g. "application/pdf").'),
        min_size: z.number().min(0).optional()
          .describe('Only downloads at least this many bytes.'),
        max_size: z.number().min(0).optional()
          .describe('Only downloads at most this many bytes.'),
        created_after: epochMsField().optional()
          .describe(`Only downloads created after this time. ${EPOCH_MS_FIELD_HINT}`),
        created_before: epochMsField().optional()
          .describe(`Only downloads created before this time. ${EPOCH_MS_FIELD_HINT}`),
        limit: z.number().int().min(1).max(100).optional()
          .describe('Page size (1-100). Default: 20.'),
        offset: z.number().int().min(0).optional()
          .describe('Number of records to skip. Default: 0. Increase by limit to page forward.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await browserbaseFetch<Record<string, unknown>>('/downloads', {
        method: 'GET',
        query: {
          sessionId: args.session_id,
          filename: args.filename,
          mimeType: args.mime_type,
          minSize: args.min_size,
          maxSize: args.max_size,
          createdAfter: args.created_after !== undefined ? epochMsToIso(args.created_after) : undefined,
          createdBefore: args.created_before !== undefined ? epochMsToIso(args.created_before) : undefined,
          limit: args.limit,
          offset: args.offset,
        },
      });
      const downloads = sanitizeList(result.downloads, sanitizeDownload, 'browserbase:list_downloads');
      return JSON.stringify({
        ok: true,
        downloads,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        message: `Found ${downloads.length} download(s) (${typeof result.total === 'number' ? `${result.total} total` : 'total unknown'}).`,
      });
    }),
  );

  server.registerTool(
    'get_download_info',
    {
      description: `Get metadata for a file downloaded inside a session (filename, MIME type, size, checksum) without fetching the bytes.

WHEN TO USE:
- Check a download's size before deciding between get_download_file (≤8MB) and the Browserbase dashboard (larger files)
- Verify integrity via the checksum

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: download_id not found → list_downloads for valid IDs

RELATED TOOLS:
- list_downloads: Discover download IDs (session_id required)
- get_download_file: Fetch the bytes

RETURNS: id, sessionId, filename, mimeType, size, checksum, createdAt.`,
      inputSchema: {
        download_id: z.string().min(1).describe('The download ID (from list_downloads).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await browserbaseFetch<Record<string, unknown>>(
        `/downloads/${encodeURIComponent(args.download_id)}`,
        { method: 'GET', headers: { 'Accept': 'application/json' } },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeDownload(result, 'browserbase:get_download_info') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'get_download_file',
    {
      description: `Fetch a downloaded file's bytes, returned base64-encoded.

WHEN TO USE:
- Retrieve a small file (≤8MB) a session downloaded so the host/user can save it locally

GOTCHAS:
- Files larger than 8MB are rejected with FILE_TOO_LARGE — open them from the Browserbase dashboard instead (find them via list_downloads)
- The content is returned base64-encoded in content_base64; decode before writing to disk

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: download_id not found → list_downloads for valid IDs
- FILE_TOO_LARGE: use list_downloads for metadata and fetch the file from the dashboard

RELATED TOOLS:
- get_download_info: Check size first
- list_downloads: Discover downloads

RETURNS: id, filename, mime_type, size, encoding ("base64"), content_base64.`,
      inputSchema: {
        download_id: z.string().min(1).describe('The download ID (from list_downloads).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const { data, contentType, contentLength } = await browserbaseFetchBytes(
        `/downloads/${encodeURIComponent(args.download_id)}`,
        { method: 'GET', headers: { 'Accept': 'application/octet-stream' } },
      );
      const size = contentLength ?? data.length;
      if (size > MAX_INLINE_DOWNLOAD_BYTES || data.length > MAX_INLINE_DOWNLOAD_BYTES) {
        throw new ConnectorError(
          `Download ${args.download_id} is too large to return inline (${Math.round(size / 1024 / 1024)}MB > 8MB limit).`,
          'FILE_TOO_LARGE',
          'Fetch this file from the Browserbase dashboard instead. Use list_downloads (session_id required) to see its metadata and confirm the file.',
        );
      }
      // Filename/mimeType come from the download metadata endpoint; the binary
      // response itself carries no trustworthy name.
      return JSON.stringify({
        ok: true,
        id: args.download_id,
        mime_type: contentType,
        size: data.length,
        encoding: 'base64',
        content_base64: data.toString('base64'),
        message: 'File bytes returned base64-encoded in content_base64. Call get_download_info for the filename and checksum.',
      });
    }),
  );

  server.registerTool(
    'delete_download',
    {
      description: `Permanently delete a file that was downloaded inside a session.

CRITICAL: There is no undo — the file bytes are removed from Browserbase storage. Confirm the download_id with get_download_info first, and fetch a copy with get_download_file if you still need the content.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: download_id not found → it may already be deleted

RELATED TOOLS:
- list_downloads / get_download_info: Confirm before deleting
- get_download_file: Save a copy first

RETURNS: ok, message. Browserbase returns HTTP 204 on success.`,
      inputSchema: {
        download_id: z.string().min(1).describe('The download ID to permanently delete. Confirm with get_download_info first.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      await browserbaseFetch<Record<string, unknown>>(
        `/downloads/${encodeURIComponent(args.download_id)}`,
        { method: 'DELETE' },
      );
      return JSON.stringify({
        ok: true,
        message: `Download ${args.download_id} deleted permanently.`,
      });
    }),
  );
}
