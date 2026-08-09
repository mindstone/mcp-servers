import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { once } from 'events';
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

// Hard cap on downloaded bytes (2 GiB) — enforced while streaming, so a
// missing or lying Content-Length cannot push the write past the bound.
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

// Test seam: lets tests shrink the cap instead of streaming 2 GiB (same
// pattern as setDnsLookupForTesting in url-safety.ts).
let maxDownloadBytes = MAX_DOWNLOAD_BYTES;
export function setMaxDownloadBytesForTesting(n: number | null): void {
  maxDownloadBytes = n ?? MAX_DOWNLOAD_BYTES;
}

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
        'By default, refuses to overwrite an existing file — pass overwrite: true to clobber. ' +
        'Overwrites are staged to a temporary sibling file and moved into place only after the download succeeds, so a failed download leaves the existing file untouched.',
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

      const overwrite = args.overwrite === true;
      const nofollow = fs.constants.O_NOFOLLOW ?? 0;
      const nonblock = fs.constants.O_NONBLOCK ?? 0;

      // An overwrite download is staged to a unique temp sibling and
      // atomically rename()d into place only after the bytes have landed,
      // so a failed download (expired URL, 410, refused redirect, stream
      // error) leaves the pre-existing file fully intact instead of
      // truncated to 0 bytes. The temp file lives in the same directory,
      // so the rename is always same-filesystem and atomic.
      let writePath = resolved;
      if (overwrite) {
        // Validate the EXISTING target object without truncating it:
        // O_NOFOLLOW refuses a symlink at the final component (ELOOP),
        // O_NONBLOCK keeps an open of a FIFO from blocking forever, and the
        // fstat rejects anything that is not a regular file. ENOENT is fine
        // — there is nothing to clobber and the rename creates the target.
        // (O_NOFOLLOW/O_NONBLOCK are unavailable on some platforms, e.g.
        // Windows; there the lstat pre-check in resolveDownloadTargetPath
        // plus this fstat remain the mitigation, and rename() never writes
        // through a swapped-in symlink anyway — it replaces the entry.)
        try {
          const targetFd = fs.openSync(resolved, fs.constants.O_WRONLY | nofollow | nonblock);
          try {
            if (!fs.fstatSync(targetFd).isFile()) {
              throw new OpusError(
                `Output path is not a regular file: ${args.output_path}`,
                'OUTPUT_PATH_NOT_REGULAR_FILE',
                'Remove or rename the existing target, or pick a different output_path.',
              );
            }
          } finally {
            try {
              fs.closeSync(targetFd);
            } catch {
              /* best-effort */
            }
          }
        } catch (targetErr) {
          if (targetErr instanceof OpusError) throw targetErr;
          const e = targetErr as NodeJS.ErrnoException;
          if (e && e.code === 'ELOOP') {
            throw new OpusError(
              `Output path is a symbolic link, refusing to write through it: ${args.output_path}`,
              'OUTPUT_PATH_IS_SYMLINK',
              'Remove or rename the existing symlink before retrying. Downloads never write through a symlink at the target, even with overwrite=true.',
            );
          }
          if (!e || e.code !== 'ENOENT') {
            throw new OpusError(
              `Could not open output_path for writing: ${e?.message || String(targetErr)}`,
              'OUTPUT_OPEN_FAILED',
              'Check that the parent directory exists and is writable.',
            );
          }
        }
        writePath = path.join(
          path.dirname(resolved),
          `.${path.basename(resolved)}.opus-download-${randomUUID()}.tmp`,
        );
      }

      // Open the write target synchronously so the refusal is atomic with
      // the open and happens BEFORE any network request. Both paths use
      // O_CREAT|O_EXCL: the non-overwrite path refuses any pre-existing
      // path; the overwrite path opens the unique temp sibling computed
      // above. O_NOFOLLOW closes the swap race in which a symlink is
      // planted at the target between the lstat pre-check and this open —
      // with plain "w" the open would silently write through it.
      let fd: number;
      try {
        fd = fs.openSync(
          writePath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow,
        );
      } catch (openErr) {
        const e = openErr as NodeJS.ErrnoException;
        if (!overwrite && e && e.code === 'EEXIST') {
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
      // be written even if it slipped past the lstat pre-check. We created
      // the file at writePath, so remove it again to keep the failure atomic.
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) {
          try {
            fs.closeSync(fd);
          } catch {
            /* best-effort */
          }
          try {
            fs.unlinkSync(writePath);
          } catch {
            /* cleanup best-effort */
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
      // stream owns it. Until then any thrown error must close the fd and
      // unlink writePath, which is always a file this call created (the
      // target itself for a fresh download, the temp sibling for an
      // overwrite) — the pre-existing overwrite target is never touched.
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

        const fileHandle = fs.createWriteStream(writePath, { fd });
        fdReleased = true;
        // The 'finish'/'error' listeners are attached BEFORE the write loop:
        // an error emitted by an early write must reject this promise, not
        // escape as an unhandled 'error' event. The noop catch keeps the
        // rejection handled on the abort path below, where the byte cap
        // throws before writeSettled is ever awaited.
        const writeSettled = new Promise<void>((resolve, reject) => {
          fileHandle.on('finish', resolve);
          fileHandle.on('error', reject);
        });
        writeSettled.catch(() => undefined);
        try {
          // Explicit reader rather than for-await iteration: aborting the
          // loop mid-body (the byte cap below) must not await the async
          // iterator's return() — some mocked transports never settle it.
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytesWritten += value.byteLength;
              if (bytesWritten > maxDownloadBytes) {
                // Not awaited — some mocked transports never settle cancel().
                reader.cancel().catch(() => undefined);
                throw new OpusError(
                  `Download exceeded the maximum size of ${maxDownloadBytes} bytes.`,
                  'DOWNLOAD_TOO_LARGE',
                  'The clip is too large to download through the connector. Download it manually from the uriForExport URL.',
                );
              }
              // Honour backpressure: write() returning false means the
              // internal buffer is full — wait for 'drain' instead of
              // buffering the rest of the response in memory. Race against
              // writeSettled: an asynchronous write failure (ENOSPC/EIO)
              // auto-destroys the stream, after which 'drain' never fires —
              // waiting on it alone would hang and leak the fd/staging file.
              if (!fileHandle.write(value)) {
                await Promise.race([once(fileHandle, 'drain'), writeSettled]);
              }
            }
          } finally {
            reader.releaseLock();
          }
          fileHandle.end();
          await writeSettled;
        } catch (streamErr) {
          fileHandle.destroy();
          try {
            fs.unlinkSync(writePath);
          } catch {
            /* cleanup best-effort */
          }
          throw streamErr;
        }

        // The bytes are durably on disk. An overwrite download now moves
        // the temp sibling into place atomically: rename() replaces the
        // destination directory entry itself, so a symlink planted at the
        // target after validation is unlinked, never written through, and
        // a failure here still leaves the pre-existing file intact.
        if (overwrite) {
          try {
            fs.renameSync(writePath, resolved);
          } catch (renameErr) {
            try {
              fs.unlinkSync(writePath);
            } catch {
              /* cleanup best-effort */
            }
            throw renameErr;
          }
        }
      } catch (err) {
        if (!fdReleased) {
          try {
            fs.closeSync(fd);
          } catch {
            /* best-effort */
          }
          try {
            fs.unlinkSync(writePath);
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
