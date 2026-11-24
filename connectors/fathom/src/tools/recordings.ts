import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fathomFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { metadata } from '../pass-through.js';
import { wrapUntrustedJsonStrings } from '../untrusted-content.js';
import { type RecordingDownload, RecordingDownloadRequestSchema, RecordingDownloadSchema } from '../types.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Fathom API key not configured',
    resolution: 'Use configure_fathom_api_key to set your API key first.',
  });
}

// Fathom metadata stays raw only when it has the expected shape (invariant #6).
function formatDownload(download: RecordingDownload) {
  const file = download.video ?? download.audio ?? null;
  return {
    download_id: metadata(download.download_id, 'id', 'fathom:download:download_id'),
    recording_id: metadata(download.recording_id, 'id', 'fathom:download:recording_id'),
    status: metadata(download.status, 'enum', 'fathom:download:status'),
    ...(file
      ? {
          url: metadata(file.url, 'url', 'fathom:download:url'),
          content_type: metadata(file.content_type ?? null, 'mime', 'fathom:download:content_type'),
          file_size_bytes: metadata(file.file_size_bytes ?? null, 'number', 'fathom:download:file_size_bytes'),
          expires_at: metadata(file.expires_at ?? null, 'time', 'fathom:download:expires_at'),
        }
      : {}),
    ...(download.failure_reason
      ? { failure_reason: wrapUntrustedJsonStrings(download.failure_reason, 'fathom:download:failure_reason') }
      : {}),
  };
}

export function registerRecordingTools(server: McpServer): void {
  server.registerTool(
    'request_fathom_recording_download',
    {
      description:
        `Start generating a downloadable file (video or audio) for a Fathom recording.

Fathom generates the file asynchronously: this returns a download_id and an
initial status. Audio-only recordings often complete immediately; video takes
longer. Poll with get_fathom_recording_download_status until status is
'completed', which carries a short-lived signed download URL.

Downloads are private to this API key and URLs expire ~24 hours after
generation — request a fresh download when one expires.
Rate limit: download requests have their own budget (30 per minute).`,
      inputSchema: z.object({
        recording_id: z.number().int().positive().describe('The recording ID of the meeting (from list_fathom_meetings)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const download = await fathomFetch(
        `/recordings/${args.recording_id}/download`,
        RecordingDownloadRequestSchema,
        { method: 'POST', body: JSON.stringify({}) },
      );

      return JSON.stringify({
        ok: true,
        ...formatDownload(download),
        ...(download.status === 'completed'
          ? {}
          : { hint: 'Poll get_fathom_recording_download_status with this download_id until status is completed.' }),
      });
    }),
  );

  server.registerTool(
    'get_fathom_recording_download_status',
    {
      description:
        `Check the status of a recording download started with request_fathom_recording_download.

Returns status ('processing', 'completed', 'failed', 'expired'). When completed,
the response includes a short-lived signed url plus content_type,
file_size_bytes, and expires_at. When failed, failure_reason explains why.
Rate limit: polling counts against the global 60 calls/minute budget.`,
      inputSchema: z.object({
        recording_id: z.number().int().positive().describe('The recording ID of the meeting'),
        download_id: z.string().min(1).describe('The download ID from request_fathom_recording_download'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const download = await fathomFetch(
        `/recordings/${args.recording_id}/downloads/${encodeURIComponent(args.download_id)}`,
        RecordingDownloadSchema,
      );

      return JSON.stringify({ ok: true, ...formatDownload(download) });
    }),
  );
}
