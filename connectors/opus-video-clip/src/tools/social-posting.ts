import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey } from '../auth.js';
import { opusFetch, classifyJobStatus, computeNextPollAfterSeconds } from '../client.js';
import { withErrorHandling } from '../utils.js';

interface OpusDataResponse<T> {
  data?: T;
}

interface SocialAccountDto {
  postAccountId: string;
  subAccountId?: string;
  platform: string;
  extUserId: string;
  extUserName: string;
  extUserPictureLink?: string;
  extUserProfileLink?: string;
}

interface SocialCopyJobResponse {
  jobId?: string;
  status?: string;
  cached?: boolean;
  title?: string;
  description?: string;
  hashtags?: string;
}

const PostDetailSchema = z.object({
  title: z.string().min(1).describe('Title of the post'),
  mediaType: z
    .string()
    .optional()
    .describe('Media type — supported values depend on the platform (typically "video")'),
  custom: z
    .object({
      description: z.string().optional(),
      privacy: z.enum(['public', 'private', 'unlisted']).optional().describe('YouTube privacy setting'),
    })
    .optional(),
});

const PostBaseSchema = z.object({
  projectId: z.string().min(1),
  clipId: z.string().min(1).describe('Curation ID (e.g. "CU67da38"), NOT the full clip id.'),
  postAccountId: z.string().min(1).describe('From opus_get_social_accounts.postAccountId'),
  subAccountId: z
    .string()
    .optional()
    .describe(
      'Required for Facebook pages, Instagram business accounts, and LinkedIn — from opus_get_social_accounts.subAccountId.',
    ),
  postDetail: PostDetailSchema,
});

export function registerSocialPostingTools(server: McpServer): void {
  // ── opus_get_social_accounts ──────────────────────────────────────

  server.registerTool(
    'opus_get_social_accounts',
    {
      description:
        'List the social accounts connected to your Opus organisation. ' +
        'Returns `postAccountId`, `subAccountId` (where applicable), `platform`, and the platform-side `extUser*` identifiers. ' +
        'Use these IDs with opus_publish_post, opus_schedule_post, and opus_create_social_copy_job.',
      inputSchema: z.object({
        q: z.literal('mine').default('mine').describe('Must be the literal string "mine".'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const params = new URLSearchParams({ q: args.q });
      const result = await opusFetch<OpusDataResponse<SocialAccountDto[]>>(
        `/api/social-accounts?${params.toString()}`,
      );
      return JSON.stringify(
        {
          ok: true,
          count: result.data?.length ?? 0,
          accounts: result.data ?? [],
        },
        null,
        2,
      );
    }),
  );

  // ── opus_create_social_copy_job ───────────────────────────────────

  server.registerTool(
    'opus_create_social_copy_job',
    {
      description:
        'Create an asynchronous social-copy generation job. Opus produces a platform-specific title, description, and hashtags for a clip + destination account. ' +
        'Returns a jobId — poll opus_get_social_copy_job until status is "COMPLETED" or "FAILED".',
      inputSchema: z.object({
        projectId: z.string().min(1),
        clipId: z.string().min(1),
        postAccountId: z.string().min(1),
        subAccountId: z.string().min(1),
        prompt: z
          .string()
          .optional()
          .describe('Optional style or tone instruction (e.g. "playful and witty").'),
        forceRegenerate: z
          .boolean()
          .optional()
          .describe('If true, bypass the cached result for this clip/account pair.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<OpusDataResponse<{ jobId?: string }>>(
        '/api/social-copy-jobs',
        {
          method: 'POST',
          body: JSON.stringify(args),
        },
      );
      return JSON.stringify(
        {
          ok: true,
          jobId: result.data?.jobId,
          message: `Social copy job created. Poll opus_get_social_copy_job with jobId="${result.data?.jobId}" every 3-5 seconds until status is "COMPLETED" or "FAILED".`,
        },
        null,
        2,
      );
    }),
  );

  // ── opus_get_social_copy_job ──────────────────────────────────────

  server.registerTool(
    'opus_get_social_copy_job',
    {
      description:
        'Poll the status and result of a social-copy generation job. ' +
        'Status values: "RUNNING" (still generating), "COMPLETED" (returns title/description/hashtags), "FAILED". ' +
        'Includes `next_poll_after_seconds` honouring Retry-After.',
      inputSchema: z.object({
        jobId: z.string().min(1),
        attempt: z.number().int().nonnegative().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const attempt = args.attempt ?? 1;
      const response = (await opusFetch<Response>(
        `/api/social-copy-jobs/${encodeURIComponent(args.jobId)}`,
        { rawResponse: true },
      )) as Response;
      const retryAfterHeader = response.headers.get('Retry-After');
      const text = await response.text();
      const wrapped = (text.trim() ? JSON.parse(text) : {}) as OpusDataResponse<SocialCopyJobResponse>;
      const body = wrapped.data ?? {};
      const classification = classifyJobStatus(body.status);
      const next_poll_after_seconds = computeNextPollAfterSeconds(retryAfterHeader, attempt);

      const payload: Record<string, unknown> = {
        ok: true,
        jobId: body.jobId ?? args.jobId,
        status: body.status ?? '',
        category: classification.category,
        next_poll_after_seconds,
        retry_after_header: retryAfterHeader,
      };
      if (classification.category === 'completed') {
        payload.title = body.title;
        payload.description = body.description;
        payload.hashtags = body.hashtags;
        payload.cached = body.cached;
      } else if (classification.category === 'unknown') {
        payload.error_code = 'UPSTREAM_STATUS_UNKNOWN';
        payload.message =
          'Opus returned a status the connector does not recognise. Surface to the user instead of treating as pending.';
        payload.raw = body;
      }
      return JSON.stringify(payload, null, 2);
    }),
  );

  // ── opus_publish_post ─────────────────────────────────────────────

  server.registerTool(
    'opus_publish_post',
    {
      description:
        'Publish a clip immediately to a connected social account. ' +
        'For X (formerly Twitter) each post costs 1 credit. ' +
        'Returns a `postId`. The clip is queued for upload by Opus to the destination platform.',
      inputSchema: PostBaseSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<OpusDataResponse<{ postId?: string }>>('/api/post-tasks', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      return JSON.stringify(
        {
          ok: true,
          postId: result.data?.postId,
        },
        null,
        2,
      );
    }),
  );

  // ── opus_schedule_post ────────────────────────────────────────────

  server.registerTool(
    'opus_schedule_post',
    {
      description:
        'Schedule a clip for future publishing. `publishAt` must be a future UTC ISO 8601 timestamp (e.g. "2026-06-01T16:00:00.000Z"). ' +
        'For X (formerly Twitter) each post costs 1 credit. Returns a `scheduleId` you can pass to opus_cancel_scheduled_post.',
      inputSchema: PostBaseSchema.extend({
        publishAt: z
          .string()
          .describe('Future publish time in UTC ISO 8601, e.g. "2026-06-01T16:00:00.000Z".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<OpusDataResponse<{ scheduleId?: string }>>(
        '/api/publish-schedules',
        {
          method: 'POST',
          body: JSON.stringify(args),
        },
      );
      return JSON.stringify(
        {
          ok: true,
          scheduleId: result.data?.scheduleId,
          publishAt: args.publishAt,
        },
        null,
        2,
      );
    }),
  );

  // ── opus_cancel_scheduled_post ────────────────────────────────────

  server.registerTool(
    'opus_cancel_scheduled_post',
    {
      description:
        'Cancel a scheduled social post BEFORE its publishAt time. ' +
        'After publishAt the post is irrevocably handed to the platform — cancellation is no longer possible.',
      inputSchema: z.object({
        scheduleId: z.string().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      await opusFetch<OpusDataResponse<unknown>>(
        `/api/publish-schedules/${encodeURIComponent(args.scheduleId)}`,
        { method: 'DELETE' },
      );
      return JSON.stringify(
        {
          ok: true,
          canceledScheduleId: args.scheduleId,
        },
        null,
        2,
      );
    }),
  );
}
