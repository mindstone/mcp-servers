import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertDownloadPathInRoot, validateDownloadUrl } from '../download-sandbox.js';
import { KlingError, getRequestTimeoutMs } from '../types.js';
import { unwrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';

export function registerDownloadTools(server: McpServer): void {
  // ─── download_kling_video ───────────────────────────────────────
  server.registerTool(
    'download_kling_video',
    {
      description:
        'Download a generated Kling video (or image) to a local file. ' +
        'Use after check_kling_task reports "succeed" — result URLs expire 30 days after generation, so save anything you want to keep. ' +
        'output_path MUST live inside KLING_DOWNLOAD_ROOT (default ~/Downloads/kling-mcp). ' +
        'Sensitive paths (~/.ssh, ~/.aws, /etc, ~/.bashrc, ~/.zshrc) are refused even when the root would otherwise permit them. ' +
        'By default, refuses to overwrite an existing file — pass overwrite: true to clobber.',
      inputSchema: z.object({
        url: z.string().describe('Result URL from a completed task (video.url or image url).'),
        output_path: z
          .string()
          .describe(
            'Local file path to save to. Must be inside KLING_DOWNLOAD_ROOT (default ~/Downloads/kling-mcp). Parent directory must exist.',
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            'If true, replace an existing file at output_path. Defaults to false (refuses to clobber).',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      // Accept URLs echoed back from this connector's own enveloped output.
      const url = unwrapUntrusted(args.url);
      const outputPath = args.output_path;
      const overwrite = args.overwrite === true;

      // Validate URL (SSRF prevention — blocks private/reserved hosts)
      const urlError = validateDownloadUrl(url);
      if (urlError) {
        return JSON.stringify({ ok: false, error: urlError });
      }

      // Sandbox the output path BEFORE any network call (outside-root,
      // `..` traversal, symlink-escape on the parent, sensitive deny-list).
      const fs = await import('fs');
      let safe: { resolved: string; root: string };
      try {
        safe = assertDownloadPathInRoot(outputPath);
      } catch (err) {
        if (err instanceof KlingError) {
          return JSON.stringify({ ok: false, error: err.message, code: err.code, resolution: err.resolution });
        }
        throw err;
      }

      // Open the output file synchronously with `wx` (or `w` if overwrite) so
      // the EEXIST refusal is atomic with the open and happens BEFORE any
      // network request.
      const writeFlag = overwrite ? 'w' : 'wx';
      let fd: number;
      try {
        fd = fs.openSync(safe.resolved, writeFlag);
      } catch (openErr) {
        const e = openErr as NodeJS.ErrnoException;
        if (e && e.code === 'EEXIST') {
          return JSON.stringify({
            ok: false,
            error: `Output file already exists: ${outputPath}. Pass overwrite: true to clobber.`,
            code: 'EEXIST',
          });
        }
        return JSON.stringify({
          ok: false,
          error: `Could not open output_path for writing: ${e?.message || String(openErr)}`,
          code: e?.code || 'OPEN_FAILED',
        });
      }

      // SSRF-via-redirect defence: fetch with `redirect: 'manual'` and
      // re-validate every Location target against the same allow-list before
      // following it; cap the chain depth.
      const MAX_REDIRECTS = 5;
      // fd ownership transfers to the write stream on the createWriteStream
      // hand-off; until then any thrown exception must close the fd and
      // unlink the freshly created file so the failure is atomic.
      let fdReleased = false;
      let bytesWritten = 0;
      try {
        let response: Response;
        let currentUrl = url;
        let redirectCount = 0;
        let redirectError: string | null = null;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          response = await fetch(currentUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(getRequestTimeoutMs()),
          });
          if (response.status >= 300 && response.status < 400) {
            // Drain the redirect body so the connection isn't held open.
            try {
              await response.body?.cancel();
            } catch {
              /* best-effort */
            }

            redirectCount++;
            if (redirectCount > MAX_REDIRECTS) {
              redirectError = `Refused to follow redirect: too many redirects (>${MAX_REDIRECTS}).`;
              break;
            }

            const location = response.headers.get('location');
            if (!location) {
              redirectError = 'Redirect response missing Location header.';
              break;
            }

            let nextUrl: string;
            try {
              nextUrl = new URL(location, currentUrl).toString();
            } catch {
              redirectError = `Refused to follow redirect: invalid Location header (${location}).`;
              break;
            }

            // Re-apply the same SSRF allow-list to every redirect target.
            const validationError = validateDownloadUrl(nextUrl);
            if (validationError) {
              redirectError = `Refused to follow redirect to ${nextUrl}: ${validationError}`;
              break;
            }

            currentUrl = nextUrl;
            continue;
          }
          break;
        }

        if (redirectError) {
          try {
            fs.closeSync(fd);
          } catch {
            /* empty */
          }
          fdReleased = true;
          try {
            fs.unlinkSync(safe.resolved);
          } catch {
            /* cleanup best-effort */
          }
          return JSON.stringify({ ok: false, error: redirectError });
        }
        if (!response.ok) {
          try {
            fs.closeSync(fd);
          } catch {
            /* empty */
          }
          fdReleased = true;
          try {
            fs.unlinkSync(safe.resolved);
          } catch {
            /* cleanup best-effort */
          }
          return JSON.stringify({
            ok: false,
            error: `Download failed (HTTP ${response.status}). The URL may have expired.`,
          });
        }
        if (!response.body) {
          try {
            fs.closeSync(fd);
          } catch {
            /* empty */
          }
          fdReleased = true;
          try {
            fs.unlinkSync(safe.resolved);
          } catch {
            /* cleanup best-effort */
          }
          return JSON.stringify({ ok: false, error: 'No response body received.' });
        }

        // Hand the open fd to a write stream (avoids re-opening with default
        // `w` and so preserves the wx semantics of our pre-check).
        const fileHandle = fs.createWriteStream(safe.resolved, { fd });
        fdReleased = true; // fd ownership transferred to the stream
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
            fs.unlinkSync(safe.resolved);
          } catch {
            /* cleanup best-effort */
          }
          throw streamErr;
        }
      } catch (err) {
        // Resource hygiene: if anything between `fs.openSync` and the
        // `createWriteStream` hand-off threw (e.g. `fetch` rejecting with a
        // network error), close the fd we own and unlink the freshly created
        // file so the failure is atomic.
        if (!fdReleased) {
          try {
            fs.closeSync(fd);
          } catch {
            /* empty */
          }
          try {
            fs.unlinkSync(safe.resolved);
          } catch {
            /* cleanup best-effort */
          }
        }
        throw err;
      }

      const sizeMB = (bytesWritten / 1_048_576).toFixed(1);
      // Report the user-supplied (lexical) path so it matches what the caller
      // passed; the actual write used the realpath-canonical target.
      return JSON.stringify({
        ok: true,
        path: outputPath,
        size_mb: sizeMB,
        message: `Downloaded ${sizeMB}MB to ${outputPath}`,
      });
    }),
  );
}
