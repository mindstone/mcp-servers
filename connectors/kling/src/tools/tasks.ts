import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { klingFetch } from '../client.js';
import { KlingError, TASK_TYPE_PATHS, type KlingTaskType, type TaskListItem } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerTaskListTools(server: McpServer): void {
  // ─── list_kling_tasks ───────────────────────────────────────────
  server.registerTool(
    'list_kling_tasks',
    {
      description:
        'List your Kling generation tasks, newest first, with pagination. ' +
        'Use to find a recent task_id (for check_kling_task) or a video id (for extend_kling_video / generate_kling_lip_sync) without having saved it.\n\n' +
        'TASK TYPES: "text2video", "image2video", "video-extend", "lip-sync", "image" (one list per type).\n' +
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

      const data = await klingFetch<TaskListItem[]>(
        `${TASK_TYPE_PATHS[taskType]}?pageNum=${page}&pageSize=${pageSize}`,
      );

      if (!Array.isArray(data)) {
        throw new KlingError(
          'Unexpected response shape from the Kling task list endpoint',
          'UNEXPECTED_RESPONSE',
          'The Kling API may have changed. Try again, or check a specific task with check_kling_task.',
        );
      }

      // Surface only IDs, status, timestamps, and result URLs — task_info
      // echoes the caller's prompt and is deliberately not returned.
      const tasks = data.map((item) => {
        const entry: Record<string, unknown> = {
          task_id: item.task_id,
          task_status: item.task_status,
        };
        if (item.task_status_msg) entry.task_status_msg = item.task_status_msg;
        if (item.created_at) entry.created_at = item.created_at;
        if (item.updated_at) entry.updated_at = item.updated_at;
        if (item.task_result?.videos?.length) {
          entry.videos = item.task_result.videos.map((v) => ({
            id: v.id,
            url: v.url,
            duration: v.duration,
          }));
        }
        if (item.task_result?.images?.length) {
          entry.images = item.task_result.images.map((img) => ({ url: img.url }));
        }
        return entry;
      });

      return JSON.stringify({
        ok: true,
        task_type: taskType,
        page,
        page_size: pageSize,
        count: tasks.length,
        tasks,
      });
    }),
  );
}
