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
        'Only Kling result URLs (klingai.com hosts) are accepted. ' +
        'output_path MUST live inside the download sandbox (default <workspace>/kling-downloads, where the workspace is MCP_WORKSPACE_PATH or the system temp directory; KLING_DOWNLOAD_ROOT may redirect it but only to a directory inside the workspace). ' +
        'Sensitive paths (~/.ssh, ~/.aws, /etc, ~/.bashrc, ~/.zshrc) are refused even when the root would otherwise permit them. ' +
        'By default, refuses to overwrite an existing file — pass overwrite: true to clobber.',
      inputSchema: z.object({
        url: z
          .string()
          .describe('Result URL from a completed task (video.url or image url). Must be a Kling host (klingai.com).'),
        output_path: z
          .string()
          .describe(
            'Local file path to save to. Must be inside the download sandbox (default <workspace>/kling-downloads). Parent directory must exist.',
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
      const path = await import('path');
      let safe: { resolved: string; root: string; existing?: { dev: number; ino: number } };
      try {
        safe = assertDownloadPathInRoot(outputPath);
      } catch (err) {
        if (err instanceof KlingError) {
          return JSON.stringify({ ok: false, error: err.message, code: err.code, resolution: err.resolution });
        }
        throw err;
      }

      // The byte write goes to a fresh, unpredictable staging directory
      // created atomically with fs.mkdtempSync (0700) directly inside the
      // verified root — never re-trust a validated pathname for the write
      // itself, so no check-then-use swap of any path component (validated
      // parent included) can redirect the bytes. The staging file is opened
      // O_CREAT|O_EXCL (mode 0600), fstat-checked to be a regular file, and
      // written through the single fd.
      const stagingDir = fs.mkdtempSync(path.join(safe.root, '.kling-staging-'));
      let bytesWritten = 0;
      try {
        const stagingFile = path.join(stagingDir, path.basename(safe.resolved));
        const fd = fs.openSync(
          stagingFile,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
        if (!fs.fstatSync(fd).isFile()) {
          try {
            fs.closeSync(fd);
          } catch {
            /* empty */
          }
          return JSON.stringify({
            ok: false,
            error: 'Download staging path is not a regular file.',
            code: 'OUTPUT_PATH_REJECTED',
          });
        }

        // SSRF-via-redirect defence: fetch with `redirect: 'manual'` and
        // re-validate every Location target against the same allow-list before
        // following it; cap the chain depth.
        const MAX_REDIRECTS = 5;
        // fd ownership transfers to the write stream on the createWriteStream
        // hand-off; until then any thrown exception must close the fd.
        let fdReleased = false;
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
                // Do not echo the Location header: signed CDN query strings or
                // bearer parameters must not be copied into model-visible output.
                redirectError = 'Refused to follow redirect: the redirect target is not a valid URL.';
                break;
              }

              // Re-apply the same SSRF allow-list to every redirect target.
              const validationError = validateDownloadUrl(nextUrl);
              if (validationError) {
                redirectError = `Refused to follow redirect: the redirect target failed safety validation (${validationError})`;
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
            return JSON.stringify({ ok: false, error: redirectError });
          }
          if (!response.ok) {
            try {
              fs.closeSync(fd);
            } catch {
              /* empty */
            }
            fdReleased = true;
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
            return JSON.stringify({ ok: false, error: 'No response body received.' });
          }

          // Hand the open fd to a write stream (avoids re-opening with default
          // `w` and so preserves the O_EXCL semantics of the staging create).
          const fileHandle = fs.createWriteStream(stagingFile, { fd });
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
            throw streamErr;
          }
        } catch (err) {
          // Resource hygiene: if anything between `fs.openSync` and the
          // `createWriteStream` hand-off threw (e.g. `fetch` rejecting with a
          // network error), close the fd we own.
          if (!fdReleased) {
            try {
              fs.closeSync(fd);
            } catch {
              /* empty */
            }
          }
          throw err;
        }

        // ── Placement: metadata-only, never follows a planted symlink ──
        // Re-verify the parent directory first: it must still canonically be
        // the directory validated above. A mid-download swap-for-symlink is
        // refused observably rather than silently writing outside the root.
        let currentParent: string;
        try {
          currentParent = fs.realpathSync(path.dirname(safe.resolved));
        } catch {
          return JSON.stringify({
            ok: false,
            error: `Output parent directory changed or disappeared during download: ${outputPath}`,
            code: 'OUTPUT_PARENT_CHANGED',
            resolution: 'Retry the download; the destination directory was modified while the file was downloading.',
          });
        }
        if (currentParent !== path.dirname(safe.resolved)) {
          return JSON.stringify({
            ok: false,
            error: `Output parent directory was replaced during download, refusing to place the file: ${outputPath}`,
            code: 'OUTPUT_PARENT_CHANGED',
            resolution: 'Retry the download; the destination directory was modified while the file was downloading.',
          });
        }

        if (!overwrite) {
          // Hard-link into place: linkSync fails with EEXIST when the
          // destination name is taken — by a real file OR a symlink — so
          // existing content is never overwritten and a planted symlink is
          // never followed. The staging directory is a child of the same
          // root, so the link is always same-filesystem; filesystems without
          // hard-link support fall back to an exclusive copy (same
          // no-clobber semantics).
          try {
            fs.linkSync(stagingFile, safe.resolved);
          } catch (linkErr) {
            const e = linkErr as NodeJS.ErrnoException;
            if (e?.code === 'EEXIST') {
              return JSON.stringify({
                ok: false,
                error: `Output file already exists: ${outputPath}. Pass overwrite: true to clobber.`,
                code: 'EEXIST',
              });
            }
            if (e?.code === 'EXDEV') {
              try {
                fs.copyFileSync(stagingFile, safe.resolved, fs.constants.COPYFILE_EXCL);
              } catch (copyErr) {
                if ((copyErr as NodeJS.ErrnoException)?.code === 'EEXIST') {
                  return JSON.stringify({
                    ok: false,
                    error: `Output file already exists: ${outputPath}. Pass overwrite: true to clobber.`,
                    code: 'EEXIST',
                  });
                }
                throw copyErr;
              }
            } else {
              throw linkErr;
            }
          }
        } else {
          // Overwrite: confirm the target is still the same regular file we
          // validated (never a swapped-in symlink or replacement), then
          // atomically rename over it. rename(2) replaces the destination
          // directory entry itself — a symlink or hardlink planted at the
          // target after validation is unlinked, never followed or written
          // through, so out-of-root content cannot be clobbered.
          try {
            const lst = fs.lstatSync(safe.resolved);
            if (lst.isSymbolicLink() || !lst.isFile()) {
              return JSON.stringify({
                ok: false,
                error: `Output path was replaced by a non-regular file during download, refusing to overwrite it: ${outputPath}`,
                code: 'OUTPUT_PATH_CHANGED',
                resolution: 'Remove or rename the existing target before retrying, or pick a different output_path.',
              });
            }
            if (safe.existing && (lst.dev !== safe.existing.dev || lst.ino !== safe.existing.ino)) {
              return JSON.stringify({
                ok: false,
                error: `Output file was replaced during download, refusing to overwrite it: ${outputPath}`,
                code: 'OUTPUT_PATH_CHANGED',
                resolution: 'Retry the download; the destination file was modified while the file was downloading.',
              });
            }
          } catch (lstatErr) {
            // ENOENT (target removed mid-download) is fine: rename creates it.
            if ((lstatErr as NodeJS.ErrnoException)?.code !== 'ENOENT') throw lstatErr;
          }
          try {
            fs.renameSync(stagingFile, safe.resolved);
          } catch (renameErr) {
            const e = renameErr as NodeJS.ErrnoException;
            if (e?.code !== 'EXDEV') throw renameErr;
            // Rare: staging and target on different filesystems (e.g. a mount
            // inside the root). Fall back to a truncate-through-fd write with
            // the same identity re-verification.
            const nofollow = fs.constants.O_NOFOLLOW ?? 0;
            let destFd: number;
            try {
              destFd = fs.openSync(
                safe.resolved,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | nofollow,
                0o600,
              );
            } catch (openErr) {
              if ((openErr as NodeJS.ErrnoException)?.code === 'ELOOP') {
                return JSON.stringify({
                  ok: false,
                  error: `Output path is a symbolic link, refusing to write through it: ${outputPath}`,
                  code: 'OUTPUT_PATH_IS_SYMLINK',
                });
              }
              throw openErr;
            }
            try {
              const fst = fs.fstatSync(destFd);
              if (
                !fst.isFile() ||
                (safe.existing && (fst.dev !== safe.existing.dev || fst.ino !== safe.existing.ino))
              ) {
                return JSON.stringify({
                  ok: false,
                  error: `Output file was replaced during download, refusing to overwrite it: ${outputPath}`,
                  code: 'OUTPUT_PATH_CHANGED',
                });
              }
              fs.writeFileSync(destFd, fs.readFileSync(stagingFile));
            } finally {
              fs.closeSync(destFd);
            }
          }
        }
      } finally {
        // Remove the staging directory (and any unplaced partial download) so
        // a failure never leaves a completed-looking file behind.
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          /* cleanup best-effort */
        }
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
