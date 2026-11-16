import { randomUUID } from 'crypto';
import * as path from 'path';
import { centralReadPath, fileReadContext } from '../file-read-context.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  runwayFetch,
  runwayRawFetch,
  validateDownloadUrl,
  assertDownloadPathInRoot,
  RUNWAY_API_SOURCE,
} from '../client.js';
import { RunwayError, type TaskDetail } from '../types.js';
import { pathSegment, withErrorHandling } from '../utils.js';
import { wrapUntrusted } from '../untrusted-content.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function registerTaskTools(server: McpServer): void {
  // ── Check Task ────────────────────────────────────────────────────────
  server.registerTool(
    'check_runway_task',
    {
      description:
        'Check the status of any Runway generation task. ' +
        'STATUS VALUES: PENDING → THROTTLED → RUNNING → SUCCEEDED (output URLs) or FAILED. ' +
        'TIP: Use wait_for_runway_task for automatic polling.',
      inputSchema: z.object({
        task_id: z.string().describe('Task ID from any generate_* tool.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const result = await runwayFetch<TaskDetail>(`/tasks/${pathSegment(args.task_id)}`);
      const response: Record<string, unknown> = {
        ok: true, task_id: result.id, status: result.status, created_at: result.createdAt,
      };

      if (result.status === 'PENDING' || result.status === 'THROTTLED') {
        response.message = `Task ${result.status.toLowerCase()}. Poll again in 15 seconds.`;
      } else if (result.status === 'RUNNING') {
        response.message = 'Generation in progress. Poll again in 20 seconds.';
      } else if (result.status === 'SUCCEEDED' && result.output?.length) {
        response.output = result.output;
        response.message = 'Generation complete! Output URLs are ready.';
      } else if (result.status === 'FAILED') {
        response.ok = false;
        response.error = result.failure
          ? wrapUntrusted(result.failure, RUNWAY_API_SOURCE) : 'Generation failed.';
        response.failure_code = wrapUntrusted(result.failureCode, RUNWAY_API_SOURCE);
      }
      return JSON.stringify(response);
    }),
  );

  // ── Wait for Task ─────────────────────────────────────────────────────
  server.registerTool(
    'wait_for_runway_task',
    {
      description:
        'Submit a task ID and wait for it to complete. Polls automatically. ' +
        'Returns the final task result including output URLs when successful.',
      inputSchema: z.object({
        task_id: z.string().describe('Task ID from any generate_* tool.'),
        poll_interval: z.number().optional().describe('Seconds between polls. Default: 15. Min: 5.'),
        timeout: z.number().optional().describe('Max seconds to wait. Default: 300 (5 min). Max: 600.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const pollInterval = Math.max(5, args.poll_interval || 15) * 1000;
      const timeout = Math.min(600, Math.max(30, args.timeout || 300)) * 1000;
      const taskId = args.task_id;
      const taskPath = `/tasks/${pathSegment(taskId)}`;
      const startTime = Date.now();
      const maxTransientErrors = 3;
      let transientErrors = 0;

      while (Date.now() - startTime < timeout) {
        let result: TaskDetail;
        try {
          result = await runwayFetch<TaskDetail>(taskPath);
          transientErrors = 0;
        } catch (pollErr) {
          transientErrors++;
          if (transientErrors >= maxTransientErrors) throw pollErr;
          await sleep(pollInterval);
          continue;
        }

        if (result.status === 'SUCCEEDED') {
          return JSON.stringify({
            ok: true, task_id: result.id, status: 'SUCCEEDED',
            output: result.output, created_at: result.createdAt,
            elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
            message: 'Generation complete! Output URLs are ready. Use download_runway_output to save locally.',
          });
        }

        if (result.status === 'FAILED') {
          return JSON.stringify({
            ok: false, task_id: result.id, status: 'FAILED',
            error: result.failure ? wrapUntrusted(result.failure, RUNWAY_API_SOURCE) : 'Generation failed.',
            failure_code: wrapUntrusted(result.failureCode, RUNWAY_API_SOURCE),
            elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
          });
        }

        await sleep(pollInterval);
      }

      return JSON.stringify({
        ok: false, task_id: taskId, status: 'TIMEOUT',
        error: `Task did not complete within ${timeout / 1000}s. It may still be running — check with check_runway_task.`,
        elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
      });
    }),
  );

  // ── Cancel/Delete Task ────────────────────────────────────────────────
  server.registerTool(
    'cancel_runway_task',
    {
      description: 'Cancel a pending/running task or delete a completed task. Saves credits if cancelled before completion.',
      inputSchema: z.object({
        task_id: z.string().describe('Task ID to cancel or delete.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const cancelRes = await runwayRawFetch(`/tasks/${pathSegment(args.task_id)}`, { method: 'DELETE' });
      if (!cancelRes.ok && cancelRes.status !== 204) {
        throw new RunwayError(
          `Failed to cancel task (HTTP ${cancelRes.status})`,
          `HTTP_${cancelRes.status}`,
          'Check the task ID and try again.',
        );
      }
      return JSON.stringify({ ok: true, message: `Task ${args.task_id} cancelled/deleted.` });
    }),
  );

  // ── Download Output ───────────────────────────────────────────────────
  server.registerTool(
    'download_runway_output',
    {
      description:
        'Download a Runway output (video, image, audio) to a local file. ' +
        'Use after a task succeeds to save the output locally. ' +
        'output_path MUST live inside RUNWAY_DOWNLOAD_ROOT (default ~/Downloads/runway-mcp). ' +
        'Sensitive paths (~/.ssh, ~/.aws, /etc, ~/.bashrc, ~/.zshrc) are refused even when the root would otherwise permit them. ' +
        'By default, refuses to overwrite an existing file (atomic flags: "wx") — pass overwrite: true to replace it. ' +
        'An overwrite is staged to a temporary file and moved into place only after the download succeeds, so a failed download leaves the existing file untouched.',
      inputSchema: z.object({
        url: z.string().describe('Output URL from a completed task.'),
        output_path: z.string().describe(
          'Local file path to save to. Must be inside RUNWAY_DOWNLOAD_ROOT (default ~/Downloads/runway-mcp). Parent directory must exist.',
        ),
        overwrite: z.boolean().optional().describe(
          'If true, replace an existing file at output_path once the download succeeds; a failed download keeps the existing file. Defaults to false (refuses to clobber).',
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const url = args.url;
      const outputPath = args.output_path;
      const overwrite = args.overwrite === true;

      // Validate URL (SSRF prevention — blocks private/reserved hosts)
      const urlError = validateDownloadUrl(url);
      if (urlError) {
        return JSON.stringify({ ok: false, error: urlError });
      }

      // Sandbox the output path BEFORE any network call. This catches:
      //   - paths outside RUNWAY_DOWNLOAD_ROOT,
      //   - `..` traversal,
      //   - symlink-escape on the parent directory,
      //   - sensitive deny-list (~/.ssh, ~/.aws, /etc, ~/.bashrc, ~/.zshrc)
      //     even when the configured root would otherwise allow it.
      const fs = await import('fs');
      let safe: { resolved: string; root: string };
      try {
        safe = assertDownloadPathInRoot(outputPath);
      } catch (err) {
        if (err instanceof RunwayError) {
          return JSON.stringify({
            ok: false,
            error: err.message,
            code: err.code,
            resolution: err.resolution,
          });
        }
        throw err;
      }

      // A fresh download writes the target directly, opened with `wx` so the
      // EEXIST refusal is atomic with the open and happens BEFORE any network
      // request. An overwrite never opens the existing file: it stages into a
      // temp sibling (same directory, so the final rename stays on one
      // filesystem) that is moved into place only after the download
      // succeeds, so a failed download leaves the existing file untouched.
      // The temp name is short and target-independent so long valid target
      // names are not newly refused.
      const writePath = overwrite
        ? path.join(path.dirname(safe.resolved), `.runway-download-${randomUUID()}.tmp`)
        : safe.resolved;
      let fd: number;
      try {
        // Owner-only on creation; an overwrite's staged file carries this mode into place.
        fd = fs.openSync(writePath, 'wx', 0o600);
      } catch (openErr) {
        const e = openErr as NodeJS.ErrnoException;
        if (e && e.code === 'EEXIST' && !overwrite) {
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

      // SSRF-via-redirect defence:
      //   * Pass `redirect: 'manual'` so the runtime never silently follows a
      //     3xx hop (a public HTTPS host could otherwise redirect to
      //     `https://169.254.169.254/...` or `https://127.0.0.1/...` and
      //     exfiltrate internal data).
      //   * On a 3xx, re-validate the `Location` header against the same
      //     private-IP / non-HTTPS allow-list (`validateDownloadUrl`) before
      //     issuing the next fetch.
      //   * Cap the redirect chain depth to MAX_REDIRECTS.
      const MAX_REDIRECTS = 5;
      // Track ownership of the just-opened fd. The fd is "released" once
      // we hand it off to `fs.createWriteStream({ fd })` — after that point
      // the stream owns it and will close it on `end`/`destroy`. Until
      // then, ANY thrown exception (network failure on `fetch`, abort on
      // the body iterator, etc.) must close the fd and unlink writePath,
      // which is always a file this call created (the target for a fresh
      // download, the temp sibling for an overwrite), so the caller's
      // failure is atomic and an existing file is never touched.
      let fdReleased = false;
      let bytesWritten = 0;
      try {
        let response: Response;
        let currentUrl = url;
        let redirectCount = 0;
        let redirectError: string | null = null;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          response = await fetch(currentUrl, { redirect: 'manual' });
          if (response.status >= 300 && response.status < 400) {
            // Drain the redirect body so the connection isn't held open.
            try { await response.body?.cancel(); } catch { /* best-effort */ }

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
          try { fs.closeSync(fd); } catch { /* empty */ }
          fdReleased = true;
          try { fs.unlinkSync(writePath); } catch { /* cleanup best-effort */ }
          return JSON.stringify({ ok: false, error: redirectError });
        }
        if (!response.ok) {
          try { fs.closeSync(fd); } catch { /* empty */ }
          fdReleased = true;
          try { fs.unlinkSync(writePath); } catch { /* cleanup best-effort */ }
          return JSON.stringify({ ok: false, error: `Download failed (HTTP ${response.status}). The URL may have expired.` });
        }
        if (!response.body) {
          try { fs.closeSync(fd); } catch { /* empty */ }
          fdReleased = true;
          try { fs.unlinkSync(writePath); } catch { /* cleanup best-effort */ }
          return JSON.stringify({ ok: false, error: 'No response body received.' });
        }

        // Hand the open fd to a write stream (avoids re-opening with default
        // `w` and so preserves the wx semantics of our pre-check).
        const fileHandle = fs.createWriteStream(writePath, { fd });
        fdReleased = true; // fd ownership transferred to the stream
        // Listeners go on BEFORE the first write, so an early write error
        // rejects this promise instead of escaping as an unhandled 'error'.
        // Settle on 'close' (not 'finish') so the fd is released before the
        // rename or unlink below; Windows refuses both on an open handle.
        const writeSettled = new Promise<void>((resolve, reject) => {
          fileHandle.on('close', resolve);
          fileHandle.on('error', reject);
        });
        writeSettled.catch(() => undefined);
        try {
          for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
            fileHandle.write(chunk);
            bytesWritten += chunk.length;
          }
          fileHandle.end();
          await writeSettled;
        } catch (streamErr) {
          fileHandle.destroy();
          await new Promise<void>(resolve => {
            if (fileHandle.closed) resolve();
            else fileHandle.once('close', () => resolve());
          });
          try { fs.unlinkSync(writePath); } catch { /* cleanup best-effort */ }
          throw streamErr;
        }

        // The download succeeded: move the staged overwrite into place.
        // rename() replaces the target in one step, and a failure here
        // still leaves the existing file intact.
        if (overwrite) {
          try {
            fs.renameSync(writePath, safe.resolved);
          } catch (renameErr) {
            try { fs.unlinkSync(writePath); } catch { /* cleanup best-effort */ }
            throw renameErr;
          }
        }
      } catch (err) {
        // Resource hygiene: if anything between `fs.openSync` and the
        // `createWriteStream` hand-off threw (e.g. `fetch` rejecting with
        // a network error), close the fd we own and unlink writePath (a
        // file this call created) so the failure is atomic.
        if (!fdReleased) {
          try { fs.closeSync(fd); } catch { /* empty */ }
          try { fs.unlinkSync(writePath); } catch { /* cleanup best-effort */ }
        }
        throw err;
      }

      const sizeMB = (bytesWritten / 1_048_576).toFixed(1);
      // Use the user-supplied (lexical) path in the user-facing response so
      // the path the LLM/user sees matches the path they passed. The actual
      // open/write happens against `safe.resolved` (the realpath-canonical
      // target), which is what enforced the sandbox.
      return JSON.stringify({
        ok: true, path: outputPath, size_mb: sizeMB,
        message: `Downloaded ${sizeMB}MB to ${outputPath}`,
      });
    }),
  );

  // ── Upload Media ──────────────────────────────────────────────────────
  server.registerTool(
    'upload_media',
    {
      description:
        'Upload a local file to Runway\'s ephemeral storage, returning a runway:// URI. ' +
        'Supports files up to 200MB. URI valid for 24 hours.',
      _meta: { 'files/readInputs': { version: 1, inputs: [{ selector: ['file_path'], base: 'connectorCwd', expandTilde: false }] } },
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the local file to upload.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args, extra) => {
      const reads = fileReadContext(server.server.getClientCapabilities(), extra);
      const fs = await import('fs');
      const filePath = args.file_path;

      // Defence-in-depth: defer to uploadEphemeral, which performs the
      // RUNWAY_ALLOWED_ROOT sandbox check (via assertPathInAllowedRoot)
      // BEFORE any file read or upstream API call. The pre-existing
      // existsSync / size guards remain so non-sandbox failures keep
      // their familiar shapes (e.g. "File not found" for inside-the-root
      // missing paths). To avoid the size / not-found guards firing
      // BEFORE the sandbox check (which would mask a sandbox violation),
      // run the sandbox check first via uploadEphemeral's internals.
      const { assertPathInAllowedRoot, uploadEphemeral } = await import('../client.js');
      let safePath: string;
      try {
        safePath = centralReadPath(reads, filePath, ['file_path']) ?? assertPathInAllowedRoot(filePath);
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'PATH_OUTSIDE_ALLOWED_ROOT') {
          const e = err as { message: string; code: string; resolution: string };
          return JSON.stringify({ ok: false, error: e.message, code: e.code, resolution: e.resolution });
        }
        throw err;
      }

      if (!fs.existsSync(safePath)) {
        return JSON.stringify({ ok: false, error: `File not found: ${filePath}` });
      }
      const stats = fs.statSync(safePath);
      if (stats.size > 200 * 1_048_576) {
        return JSON.stringify({ ok: false, error: 'File exceeds 200MB limit.' });
      }
      if (stats.size < 512) {
        return JSON.stringify({ ok: false, error: 'File must be at least 512 bytes.' });
      }

      const uri = await uploadEphemeral(reads.mode === 'central' ? filePath : safePath, reads, ['file_path']);
      const sizeMB = (stats.size / 1_048_576).toFixed(1);
      return JSON.stringify({
        ok: true, runway_uri: uri, size_mb: sizeMB,
        message: `Uploaded ${sizeMB}MB. URI valid for 24 hours. Use this URI in any generation tool: ${uri}`,
      });
    }),
  );
}
