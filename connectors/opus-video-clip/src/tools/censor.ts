import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey } from '../auth.js';
import { opusFetch, classifyJobStatus, computeNextPollAfterSeconds } from '../client.js';
import { withErrorHandling } from '../utils.js';

interface CensorJobResponse {
  jobId?: string;
  message?: string;
  // Some Opus deployments wrap the response in `{data: ...}` and some return
  // a degenerate-success body `{data: {message: "No censored words found"}}`
  // with no jobId at all (when there is nothing to censor).
  data?: { jobId?: string; message?: string };
}

interface CensorJobStatusResponse {
  status?: string;
  error?: string;
  [key: string]: unknown;
}

export function registerCensorTools(server: McpServer): void {
  // ── opus_create_censor_job ─────────────────────────────────────────

  server.registerTool(
    'opus_create_censor_job',
    {
      description:
        'Create a censor job that processes a specific clip and bleeps / mutes profanity. ' +
        'Returns a jobId. Poll opus_get_censor_job_status until status is "CONCLUDED" (success) or "FAILED". ' +
        'Set `options.beepSound: true` to substitute a beep for censored words; default is to mute them.',
      inputSchema: z.object({
        projectId: z.string().min(1).describe('Project ID containing the clip to censor.'),
        clipId: z.string().min(1).describe('Clip ID to censor (the curation suffix, e.g. "CU67da38").'),
        options: z
          .object({
            beepSound: z.boolean().optional(),
          })
          .optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<CensorJobResponse>('/api/censor-jobs', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      const jobId = result.jobId ?? result.data?.jobId;
      const message = result.message ?? result.data?.message;
      if (!jobId) {
        // Opus's degenerate-success path: no profanity → no job created.
        // We surface this transparently rather than pretending a job exists.
        return JSON.stringify(
          {
            ok: true,
            jobId: null,
            category: 'completed',
            status: 'NO_CENSORED_WORDS',
            message: message ?? 'Opus found no censored words; no job was queued.',
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          ok: true,
          jobId,
          message:
            message ??
            `Censor job created. Poll opus_get_censor_job_status with jobId="${jobId}" every 5-10 seconds until status is "CONCLUDED" or "FAILED".`,
        },
        null,
        2,
      );
    }),
  );

  // ── opus_get_censor_job_status ─────────────────────────────────────

  server.registerTool(
    'opus_get_censor_job_status',
    {
      description:
        'Poll the status of an OpusClip censor job. ' +
        'Status values: "QUEUED" / "PROCESSING" (still running, poll again), "CONCLUDED" (success), "FAILED" (check error), "UNKNOWN" (Opus could not determine the state — surfaced as UPSTREAM_STATUS_UNKNOWN). ' +
        'The response includes `next_poll_after_seconds` honouring Retry-After when present.',
      inputSchema: z.object({
        jobId: z.string().min(1),
        attempt: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Current attempt number (used for exponential backoff when Retry-After is absent). Starts at 1.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const attempt = args.attempt ?? 1;
      const response = (await opusFetch<Response>(
        `/api/censor-jobs/${encodeURIComponent(args.jobId)}`,
        { rawResponse: true },
      )) as Response;

      const retryAfterHeader = response.headers.get('Retry-After');
      const text = await response.text();
      const body = (text.trim() ? JSON.parse(text) : {}) as CensorJobStatusResponse;
      const classification = classifyJobStatus(body.status);
      const next_poll_after_seconds = computeNextPollAfterSeconds(retryAfterHeader, attempt);

      const payload: Record<string, unknown> = {
        ok: true,
        jobId: args.jobId,
        status: body.status ?? '',
        category: classification.category,
        next_poll_after_seconds,
        retry_after_header: retryAfterHeader,
        raw: body,
      };
      if (classification.category === 'unknown') {
        payload.error_code = 'UPSTREAM_STATUS_UNKNOWN';
        payload.message =
          'Opus returned a status the connector does not recognise. Surface to the user instead of treating as pending.';
      } else if (classification.category === 'failed') {
        payload.error = body.error ?? null;
      }
      return JSON.stringify(payload, null, 2);
    }),
  );
}
