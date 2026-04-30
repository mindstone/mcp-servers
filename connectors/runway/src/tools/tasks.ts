import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch, runwayRawFetch, validateDownloadUrl } from '../client.js';
import { RunwayError, type TaskDetail } from '../types.js';
import { withErrorHandling } from '../utils.js';

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
      const result = await runwayFetch<TaskDetail>(`/tasks/${args.task_id}`);
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
        response.error = result.failure || 'Generation failed.';
        response.failure_code = result.failureCode;
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
      const startTime = Date.now();
      const maxTransientErrors = 3;
      let transientErrors = 0;

      while (Date.now() - startTime < timeout) {
        let result: TaskDetail;
        try {
          result = await runwayFetch<TaskDetail>(`/tasks/${taskId}`);
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
            error: result.failure || 'Generation failed.', failure_code: result.failureCode,
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
      const cancelRes = await runwayRawFetch(`/tasks/${args.task_id}`, { method: 'DELETE' });
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
        'Use after a task succeeds to save the output locally.',
      inputSchema: z.object({
        url: z.string().describe('Output URL from a completed task.'),
        output_path: z.string().describe('Local file path to save to. Parent directory must exist.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const url = args.url;
      const outputPath = args.output_path;

      // Validate URL (SSRF prevention — blocks private/reserved hosts)
      const urlError = validateDownloadUrl(url);
      if (urlError) {
        return JSON.stringify({ ok: false, error: urlError });
      }

      // Validate output path
      const fs = await import('fs');
      const pathMod = await import('path');
      const parentDir = pathMod.dirname(outputPath);
      if (!fs.existsSync(parentDir)) {
        return JSON.stringify({ ok: false, error: `Parent directory does not exist: ${parentDir}` });
      }

      const response = await fetch(url);
      if (!response.ok) {
        return JSON.stringify({ ok: false, error: `Download failed (HTTP ${response.status}). The URL may have expired.` });
      }
      if (!response.body) {
        return JSON.stringify({ ok: false, error: 'No response body received.' });
      }

      const fileHandle = fs.createWriteStream(outputPath);
      let bytesWritten = 0;
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
        try { fs.unlinkSync(outputPath); } catch { /* cleanup best-effort */ }
        throw streamErr;
      }

      const sizeMB = (bytesWritten / 1_048_576).toFixed(1);
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
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the local file to upload.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
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
        safePath = assertPathInAllowedRoot(filePath);
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

      const uri = await uploadEphemeral(safePath);
      const sizeMB = (stats.size / 1_048_576).toFixed(1);
      return JSON.stringify({
        ok: true, runway_uri: uri, size_mb: sizeMB,
        message: `Uploaded ${sizeMB}MB. URI valid for 24 hours. Use this URI in any generation tool: ${uri}`,
      });
    }),
  );
}
