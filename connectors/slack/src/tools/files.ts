import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  abortableSignal,
  assertSlackOwnedHttpsUrl,
  errorJson,
  parseSlackFileId,
  withErrorHandling,
} from '../utils.js';
import { getSlackReaderClient, getTokenProvider } from '../client.js';
import { notConnectedJson } from './auth.js';
import { wrapUntrusted } from '../untrusted-content.js';

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    'download_slack_file',
    {
      description: `Download a file attachment from Slack by its file ID.

WORKFLOW:
  1. get_slack_channel_history(channel, response_format: 'detailed')
  2. Each file has { id: "F...", name, mimetype, size }
  3. Pass id here

Returns base64 for binary files, plain text for text files. Size limit: 10MB
default (max 50MB via max_size_mb). Don't pass message permalinks or thread_ts.`,
      inputSchema: z.object({
        file_id: z
          .string()
          .optional()
          .describe('Slack file ID (e.g., "F0A8BFR53TP"). Get from get_slack_channel_history files[].id'),
        file_url: z
          .string()
          .optional()
          .describe('Slack file permalink URL (alternative to file_id; auto-extracts F... ID)'),
        max_size_mb: z.number().min(0.1).max(50).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const reader = await getSlackReaderClient();
      if (!reader) return notConnectedJson();
      if (!args.file_id && !args.file_url) {
        return errorJson({
          error: 'Either file_id or file_url is required',
          action_required:
            'Get file_id from get_slack_channel_history (detailed format), or paste a Slack file permalink.',
          next_step: 'get_slack_channel_history',
        });
      }
      const fileId = args.file_id ? parseSlackFileId(args.file_id) : parseSlackFileId(args.file_url!);
      if (!fileId) {
        return errorJson({
          error: 'Invalid file ID or URL format',
          action_required: 'File IDs match pattern F... (e.g., F0123456789).',
          next_step: 'get_slack_channel_history',
          received: args.file_id || args.file_url,
        });
      }
      const maxSizeMb = args.max_size_mb && args.max_size_mb > 0 ? Math.min(args.max_size_mb, 50) : 10;
      const maxSizeBytes = maxSizeMb * 1024 * 1024;
      const fileInfo = await reader.files.info({ file: fileId });
      const file = fileInfo.file;
      if (!file) {
        return errorJson({
          error: 'File not found',
          action_required: 'Verify the file ID exists and is accessible.',
          next_step: 'get_slack_channel_history',
          file_id: fileId,
        });
      }
      const fileSize = file.size || 0;
      if (fileSize > maxSizeBytes) {
        return errorJson({
          error: `File too large (${(fileSize / 1024 / 1024).toFixed(2)}MB exceeds ${maxSizeMb}MB limit)`,
          action_required: `Increase max_size_mb (up to 50) or fetch via url_private_download directly.`,
          next_step: 'retry_with_larger_max_size_mb',
          file_info: {
            id: file.id,
            name: file.name,
            size: fileSize,
            mimetype: file.mimetype,
            filetype: file.filetype,
          },
          url_private_download: file.url_private_download,
        });
      }
      const downloadUrl = file.url_private_download;
      if (!downloadUrl) {
        return errorJson({
          error: 'File download URL not available',
          action_required:
            'This may be an external file (Google Drive, Dropbox) or require additional permissions.',
          next_step: 'list_slack_workspaces',
          file_info: { id: file.id, name: file.name, filetype: file.filetype },
        });
      }
      const tokenProvider = getTokenProvider();
      let token: string | null = null;
      if (tokenProvider) {
        try {
          token = (await tokenProvider.getUserToken()) ?? (await tokenProvider.getBotToken());
        } catch {
          // fall through
        }
      }
      if (!token) {
        return errorJson({
          error: 'No authentication token available',
          action_required: 'Reconnect Slack via authenticate_slack_workspace.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      // Validate the Slack-supplied download URL before sending the bearer
      // token. Slack API responses are an untrusted-input surface — an
      // attacker who can influence `url_private_download` (compromised
      // upstream, malicious file metadata) could otherwise exfiltrate the
      // workspace bot token to a server they control. Throws
      // SLACK_FILE_URL_UNTRUSTED on any non-HTTPS / non-slack.com URL.
      assertSlackOwnedHttpsUrl(downloadUrl);

      // `redirect: 'manual'` prevents Node's global fetch from auto-replaying
      // the Authorization header against a redirect target. Without this, a
      // 302 from a compromised Slack CDN edge to attacker.example would leak
      // the workspace bearer token. AGENTS.md invariant #7 bans auto-follow.
      // If a redirect appears, we re-validate the new target via
      // assertSlackOwnedHttpsUrl() and issue a fresh authenticated fetch.
      const downloadResponse = await fetchSlackFileFollowingSlackRedirects(
        downloadUrl,
        token,
      );
      if (!downloadResponse.ok) {
        return errorJson({
          error: `Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`,
          action_required: 'Verify the file is still available and you have access.',
          next_step: 'retry',
          file_id: fileId,
        });
      }
      const buffer = Buffer.from(await downloadResponse.arrayBuffer());
      if (buffer.length > maxSizeBytes) {
        return errorJson({
          error: `Downloaded file too large (${(buffer.length / 1024 / 1024).toFixed(2)}MB exceeds ${maxSizeMb}MB limit)`,
          action_required: `Increase max_size_mb (up to 50) to download this file.`,
          next_step: 'retry_with_larger_max_size_mb',
          file_id: fileId,
        });
      }
      const isTextFile =
        file.mimetype?.startsWith('text/') ||
        ['application/json', 'application/xml', 'application/x-yaml', 'application/javascript'].includes(
          file.mimetype || '',
        ) ||
        ['txt', 'md', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts', 'yaml', 'yml'].includes(
          file.filetype || '',
        );
      const rawContent = isTextFile ? buffer.toString('utf-8') : buffer.toString('base64');
      const encoding = isTextFile ? 'utf-8' : 'base64';
      // Per AGENTS.md invariant #6: file content downloaded from Slack is
      // fully attacker-influenced (any workspace user can upload a crafted
      // file). Wrap text content in an <untrusted-content> envelope before
      // returning it to the LLM. Binary content (base64) is also wrapped
      // for consistency — escape-on-close-tag is a no-op against base64
      // alphabet but keeps the envelope contract uniform.
      const content = wrapUntrusted(rawContent, `slack:download-file:${file.id}`);
      return JSON.stringify({
        ok: true,
        file: {
          id: file.id,
          name: wrapUntrusted(file.name, `slack:download-file:${file.id}:name`),
          mimetype: file.mimetype,
          filetype: file.filetype,
          size: buffer.length,
          created: file.created,
          permalink: file.permalink,
        },
        content,
        encoding,
        size_bytes: buffer.length,
      });
    }),
  );
}

/**
 * Maximum redirect chain length before refusing to follow further. Slack's CDN
 * legitimately redirects file URLs once or twice across its file edge, but a
 * deep chain is a strong attacker-controlled-CDN signal.
 */
const SLACK_FILE_DOWNLOAD_MAX_REDIRECTS = 5;

/**
 * Issue a GET against a Slack-owned download URL with the workspace bearer
 * token attached, refusing to follow any redirect target that is not also a
 * Slack-owned HTTPS URL.
 *
 * Node's global `fetch` defaults to `redirect: 'follow'`, which would replay
 * the `Authorization` header against an attacker-controlled redirect target if
 * Slack (or a compromised edge) returned a 302 to a non-Slack host. We instead
 * walk the chain manually: at each hop we re-validate the redirect target via
 * `assertSlackOwnedHttpsUrl()` before reissuing the authenticated request.
 *
 * Exposed for unit testing.
 */
export async function fetchSlackFileFollowingSlackRedirects(
  initialUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  signal: AbortSignal = abortableSignal(),
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= SLACK_FILE_DOWNLOAD_MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(currentUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal,
    });
    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return response;
      }
      const nextUrl = new URL(location, currentUrl).toString();
      assertSlackOwnedHttpsUrl(nextUrl);
      currentUrl = nextUrl;
      continue;
    }
    return response;
  }
  throw new Error(
    `download_slack_file: redirect chain exceeded ${SLACK_FILE_DOWNLOAD_MAX_REDIRECTS} hops; refusing to follow further.`,
  );
}
