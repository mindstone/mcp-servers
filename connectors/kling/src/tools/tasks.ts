import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { klingFetch } from '../client.js';
import { TASK_TYPE_PATHS, taskListResponseSchema, type KlingTaskType } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';

/** Envelope source label for vendor-controlled strings in tool output. */
const KLING_SOURCE = 'kling-api';

export function registerTaskListTools(server: McpServer): void {
  // ─── list_kling_tasks ───────────────────────────────────────────
  server.registerTool(
    'list_kling_tasks',
    {
      description:
        'List your Kling generation tasks (Kling returns them newest first) with pagination. ' +
        'Use to find a recent task_id (for check_kling_task) or a video id (for extend_kling_video / generate_kling_lip_sync) without having saved it.\n\n' +
        'TASK TYPES: "text2video", "image2video", "video-extend", "lip-sync", "image" (one list per type).\n' +
        'PAGINATION: when has_more is true, call again with page = next_page to continue.\n' +
        'NOTE: result URLs expire 30 days after generation — use download_kling_video to save outputs you want to keep.',
      inputSchema: z.object({
        task_type: z
          .enum(['text2video', 'image2video', 'video-extend', 'lip-sync', 'image'])
          .optional()
          .describe('Which task list to query. Default: text2video'),
        page: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Page number (1-1000). Default: 1'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Results per page (1-500). Default: 30'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const taskType: KlingTaskType = args.task_type || 'text2video';
      const page = args.page || 1;
      const pageSize = args.page_size || 30;

      // The response is schema-validated inside klingFetch (fail-closed); a
      // non-array payload surfaces as a generic INVALID_RESPONSE error.
      const data = await klingFetch(
        `${TASK_TYPE_PATHS[taskType]}?pageNum=${page}&pageSize=${pageSize}`,
        taskListResponseSchema,
      );

      // Surface only IDs, status, timestamps, and result URLs — task_info
      // echoes the caller's prompt and is deliberately not returned. Every
      // vendor-controlled string is enveloped (invariant #6); task_status is
      // schema-constrained to a closed enum and needs no envelope.
      const tasks = data.map((item) => {
        const entry: Record<string, unknown> = {
          task_id: wrapUntrusted(item.task_id, KLING_SOURCE),
          task_status: item.task_status,
        };
        if (item.task_status_msg) {
          entry.task_status_msg = wrapUntrusted(item.task_status_msg, KLING_SOURCE);
        }
        if (item.created_at) entry.created_at = item.created_at;
        if (item.updated_at) entry.updated_at = item.updated_at;
        if (item.task_result?.videos?.length) {
          entry.videos = item.task_result.videos.map((v) => ({
            id: wrapUntrusted(v.id, KLING_SOURCE),
            url: wrapUntrusted(v.url, KLING_SOURCE),
            duration: wrapUntrusted(v.duration, KLING_SOURCE),
          }));
        }
        if (item.task_result?.images?.length) {
          entry.images = item.task_result.images.map((img) => ({
            url: wrapUntrusted(img.url, KLING_SOURCE),
          }));
        }
        return entry;
      });

      // Kling's list endpoint returns no total/continuation token, so the
      // only continuation signal available is "the page came back full".
      // Surface it explicitly — otherwise a full page is indistinguishable
      // from the end of the list and results are silently truncated.
      const hasMore = tasks.length === pageSize;

      return JSON.stringify({
        ok: true,
        task_type: taskType,
        page,
        page_size: pageSize,
        count: tasks.length,
        has_more: hasMore,
        ...(hasMore
          ? {
              next_page: page + 1,
              hint: `This page is full — more tasks may exist. Call list_kling_tasks again with page=${page + 1} to continue.`,
            }
          : {}),
        tasks,
      });
    }),
  );
}
