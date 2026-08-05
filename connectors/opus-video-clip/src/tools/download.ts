import * as fs from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey } from '../auth.js';
import { OpusError, getApiTimeoutMs } from '../types.js';
import { resolveDownloadTargetPath } from '../path-safety.js';
import {
  DOWNLOAD_ALLOWED_HOST_SUFFIXES,
  validateOutboundUrlSync,
  validateOutboundUrlWithDns,
} from '../url-safety.js';
import { withErrorHandling } from '../utils.js';

const MAX_REDIRECTS = 5;

function urlRejected(message: string): OpusError {
  return new OpusError(
    `Download URL rejected: ${message}`,
    'URL_REJECTED',
    'Pass the uriForExport URL exactly as returned by opus_get_clips or opus_export_collection.',
  );
}

export function registerDownloadTools(server: McpServer): void {
  server.registerTool(
    'opus_download_clip',
    {
      description:
        'Download an exported clip MP4 to a local file. ' +
        'Pass a `uriForExport` URL from opus_get_clips or opus_export_collection. ' +
        'Only OpusClip CDN / Google Cloud Storage hosts are accepted; hostnames are DNS-resolved and every resolved address must be public. ' +
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

      // SSRF pre-check (syntax, non-public literals, vendor host allow-list)
      // plus DNS anti-rebinding before any file is created.
      const syncError = validateOutboundUrlSync(args.url, DOWNLOAD_ALLOWED_HOST_SUFFIXES);
      if (syncError) throw urlRejected(syncError);
      const dnsError = await validateOutboundUrlWithDns(args.url, DOWNLOAD_ALLOWED_HOST_SUFFIXES);
      if (dnsError) throw urlRejected(dnsError);

      // Sandbox the output path BEFORE any network call.
      const resolved = resolveDownloadTargetPath(args.output_path);

      // Open the output file synchronously so the refusal is atomic with
      // the open and happens BEFORE any network request:
      //   - create:    O_CREAT|O_EXCL  (refuse any pre-existing path)
      //   - overwrite: O_CREAT|O_TRUNC (clobber a validated regular file)
      // O_NOFOLLOW closes the swap race in which a symlink is planted at
      // the target between the lstat pre-check and this open — with plain
      // "w" the open would silently write through it. (O_NOFOLLOW is
      // unavailable on some platforms, e.g. Windows; there the lstat
      // pre-check plus the post-open fstat remain the mitigation.)
      // O_NONBLOCK keeps an overwrite open of a raced-in FIFO from
      // blocking forever; the fstat below then rejects it.
      const overwrite = args.overwrite === true;
      const nofollow = fs.constants.O_NOFOLLOW ?? 0;
      const nonblock = fs.constants.O_NONBLOCK ?? 0;
      const openFlags = overwrite
        ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | nofollow | nonblock
        : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow;
      let fd: number;
      try {
        fd = fs.openSync(resolved, openFlags);
      } catch (openErr) {
        const e = openErr as NodeJS.ErrnoException;
        if (e && e.code === 'EEXIST') {
          throw new OpusError(
            `Output file already exists: ${args.output_path}`,
            'OUTPUT_EXISTS',
            'Pass overwrite: true to replace the existing file, or pick a different output_path.',
          );
        }
        if (e && e.code === 'ELOOP') {
          throw new OpusError(
            `Output path is a symbolic link, refusing to write through it: ${args.output_path}`,
            'OUTPUT_PATH_IS_SYMLINK',
            'Remove or rename the existing symlink before retrying. Downloads never write through a symlink at the target, even with overwrite=true.',
          );
        }
        throw new OpusError(
          `Could not open output_path for writing: ${e?.message || String(openErr)}`,
          'OUTPUT_OPEN_FAILED',
          'Check that the parent directory exists and is writable.',
        );
      }

      // Validate the OPENED object: a raced-in FIFO/socket/device must not
      // be written even if it slipped past the lstat pre-check. If we
      // created the file, remove it again so the failure is atomic.
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) {
          try {
            fs.closeSync(fd);
          } catch {
            /* best-effort */
          }
          if (!overwrite) {
            try {
              fs.unlinkSync(resolved);
            } catch {
              /* cleanup best-effort */
            }
          }
          throw new OpusError(
            `Output path is not a regular file: ${args.output_path}`,
            'OUTPUT_PATH_NOT_REGULAR_FILE',
            'Remove or rename the existing target, or pick a different output_path.',
          );
        }
      } catch (statErr) {
        if (!(statErr instanceof OpusError)) {
          try {
            fs.closeSync(fd);
          } catch {
            /* best-effort */
          }
        }
        throw statErr;
      }

      // Track fd ownership: once handed to `fs.createWriteStream({ fd })` the
      // stream owns it. Until then any thrown error must close the fd and,
      // when we created the file, unlink it so the failure is atomic.
      let fdReleased = false;
      let bytesWritten = 0;
      try {
        // SSRF-via-redirect defence: `redirect: 'manual'` so the runtime
        // never silently follows a 3xx (a signed CDN URL could otherwise
        // redirect to a private-network address); every hop is re-validated
        // against the same HTTPS / allow-list / DNS rules, depth-capped.
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
              // Do not echo the Location header: signed CDN query strings
              // must not be copied into model-visible output.
              throw new OpusError(
                'Refused to follow redirect: the redirect target is not a valid URL.',
                'DOWNLOAD_REDIRECT_REFUSED',
                'Download the clip manually from the uriForExport URL.',
              );
            }
            const hopError =
              validateOutboundUrlSync(nextUrl, DOWNLOAD_ALLOWED_HOST_SUFFIXES) ??
              (await validateOutboundUrlWithDns(nextUrl, DOWNLOAD_ALLOWED_HOST_SUFFIXES));
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
          if (!overwrite) {
            try {
              fs.unlinkSync(resolved);
            } catch {
              /* cleanup best-effort */
            }
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
          if (!overwrite) {
            try {
              fs.unlinkSync(resolved);
            } catch {
              /* cleanup best-effort */
            }
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
