import * as fs from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey } from '../auth.js';
import { OpusError, getApiTimeoutMs } from '../types.js';
import { resolveDownloadTargetPath } from '../path-safety.js';
import { validateHostname, withErrorHandling } from '../utils.js';

const MAX_REDIRECTS = 5;

/**
 * Validate a clip download URL (SSRF prevention): HTTPS only, no
 * private/loopback hosts. Returns null when valid, an error string otherwise.
 */
function validateDownloadUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL.';
  }
  if (parsed.protocol !== 'https:') {
    return 'Only HTTPS URLs are supported for download.';
  }
  try {
    validateHostname(parsed.hostname);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

export function registerDownloadTools(server: McpServer): void {
  server.registerTool(
    'opus_download_clip',
    {
      description:
        'Download an exported clip MP4 to a local file. ' +
        'Pass a `uriForExport` URL from opus_get_clips or opus_export_collection. ' +
        'output_path MUST live inside the workspace sandbox (MCP_WORKSPACE_PATH when set, otherwise the system temp directory); ' +
        'paths outside it, `..` traversal, and symlinked targets are refused. ' +
        'By default, refuses to overwrite an existing file — pass overwrite: true to clobber.',
      inputSchema: z.object({
        url: z.string().min(1).describe('The `uriForExport` URL of the clip to download.'),
        output_path: z
          .string()
          .min(1)
          .describe(
            'Local file path to save to. Must be inside the workspace sandbox (MCP_WORKSPACE_PATH, or the system temp directory when unset). Parent directory must exist.',
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe('If true, replace an existing file at output_path. Defaults to false (refuses to clobber).'),
      }),
      // Writes a file to local disk (potentially clobbering with overwrite).
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();

      const urlError = validateDownloadUrl(args.url);
      if (urlError) {
        throw new OpusError(
          `Download URL rejected: ${urlError}`,
          'URL_REJECTED',
          'Pass the uriForExport URL exactly as returned by opus_get_clips or opus_export_collection.',
        );
      }

      // Sandbox the output path BEFORE any network call.
      const resolved = resolveDownloadTargetPath(args.output_path);

      // Open with `wx` (atomic refuse-on-existing) unless overwrite is set,
      // so the EEXIST refusal happens before we issue any network request.
      const writeFlag = args.overwrite === true ? 'w' : 'wx';
      let fd: number;
      try {
        fd = fs.openSync(resolved, writeFlag);
      } catch (openErr) {
        const e = openErr as NodeJS.ErrnoException;
        if (e && e.code === 'EEXIST') {
          throw new OpusError(
            `Output file already exists: ${args.output_path}`,
            'OUTPUT_EXISTS',
            'Pass overwrite: true to replace the existing file, or pick a different output_path.',
          );
        }
        throw new OpusError(
          `Could not open output_path for writing: ${e?.message || String(openErr)}`,
          'OUTPUT_OPEN_FAILED',
          'Check that the parent directory exists and is writable.',
        );
      }

      // Track fd ownership: once handed to `fs.createWriteStream({ fd })` the
      // stream owns it. Until then any thrown error must close the fd and
      // unlink the freshly created file so the failure is atomic.
      let fdReleased = false;
      let bytesWritten = 0;
      try {
        // SSRF-via-redirect defence: `redirect: 'manual'` so the runtime
        // never silently follows a 3xx (a signed CDN URL could otherwise
        // redirect to a private-network address); every hop is re-validated
        // against the same HTTPS / no-private-host rule, depth-capped.
        let response: Response;
        let currentUrl = args.url;
        let redirectCount = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          response = await fetch(currentUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(getApiTimeoutMs()),
          });
          if (response.status >= 300 && response.status < 400) {
            try {
              await response.body?.cancel();
            } catch {
              /* best-effort */
            }
            redirectCount++;
            if (redirectCount > MAX_REDIRECTS) {
              throw new OpusError(
                `Refused to follow redirect: too many redirects (>${MAX_REDIRECTS}).`,
                'DOWNLOAD_REDIRECT_REFUSED',
                'Download the clip manually from the uriForExport URL.',
              );
            }
            const location = response.headers.get('location');
            if (!location) {
              throw new OpusError(
                'Redirect response missing Location header.',
                'DOWNLOAD_REDIRECT_REFUSED',
                'Download the clip manually from the uriForExport URL.',
              );
            }
            let nextUrl: string;
            try {
              nextUrl = new URL(location, currentUrl).toString();
            } catch {
              throw new OpusError(
                'Refused to follow redirect: invalid Location header.',
                'DOWNLOAD_REDIRECT_REFUSED',
                'Download the clip manually from the uriForExport URL.',
              );
            }
            const hopError = validateDownloadUrl(nextUrl);
            if (hopError) {
              throw new OpusError(
                `Refused to follow redirect: ${hopError}`,
                'DOWNLOAD_REDIRECT_REFUSED',
                'The clip URL redirected to a disallowed address. Download it manually instead.',
              );
            }
            currentUrl = nextUrl;
            continue;
          }
          break;
        }

        if (!response.ok) {
          throw new OpusError(
            `Download failed (HTTP ${response.status}). The URL may have expired.`,
            'DOWNLOAD_FAILED',
            'Export URLs are time-limited. Re-run opus_get_clips or opus_export_collection for a fresh URL.',
          );
        }
        if (!response.body) {
          throw new OpusError(
            'No response body received.',
            'DOWNLOAD_FAILED',
            'Re-run opus_get_clips or opus_export_collection for a fresh URL and try again.',
          );
        }

        const fileHandle = fs.createWriteStream(resolved, { fd });
        fdReleased = true;
        try {
          for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
            fileHandle.write(chunk);
            bytesWritten += chunk.length;
          }
          fileHandle.end();
          await new Promise<void>((resolve, reject) => {
            fileHandle.on('finish', resolve);
            fileHandle.on('error', reject);
          });
        } catch (streamErr) {
          fileHandle.destroy();
          try {
            fs.unlinkSync(resolved);
          } catch {
            /* cleanup best-effort */
          }
          throw streamErr;
        }
      } catch (err) {
        if (!fdReleased) {
          try {
            fs.closeSync(fd);
          } catch {
            /* best-effort */
          }
          try {
            fs.unlinkSync(resolved);
          } catch {
            /* cleanup best-effort */
          }
        }
        throw err;
      }

      const sizeMB = (bytesWritten / 1_048_576).toFixed(1);
      return JSON.stringify(
        {
          ok: true,
          path: args.output_path,
          bytes: bytesWritten,
          size_mb: sizeMB,
          message: `Downloaded ${sizeMB}MB to ${args.output_path}`,
        },
        null,
        2,
      );
    }),
  );
}
