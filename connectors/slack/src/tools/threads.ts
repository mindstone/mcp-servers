import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson, slackTsToDatetime, withErrorHandling } from '../utils.js';
import { getSlackReaderClient } from '../client.js';
import {
  enrichMessageWithUserInfo,
  extractUserIdsFromMessages,
  mapSlackFiles,
  resolveChannelId,
  resolveUserIdsToCache,
} from '../helpers.js';
import { notConnectedJson } from './auth.js';
import { wrapUntrusted } from '../untrusted-content.js';

export function registerThreadTools(server: McpServer): void {
  server.registerTool(
    'get_slack_thread_replies',
    {
      description: `Get all replies in a message thread.

Get ts_slack from a message with reply_count > 0 (the thread parent).

Replies may include files[] (attachments — each with id, name, mimetype, size);
use download_slack_file with files[].id to download an attachment.`,
      inputSchema: z.object({
        channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
        ts: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Parent message timestamp — use ts_slack from get_slack_channel_history. thread_ts is accepted as an alias; when both are given, ts wins.',
          ),
        // Slack-API name models send. The MCP SDK cannot express
        // "at least one of ts/thread_ts" in a plain Zod object, so the
        // both-absent case is rejected in the handler below.
        thread_ts: z.string().min(1).optional().describe('Alias for ts.'),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const reader = await getSlackReaderClient();
      if (!reader) return notConnectedJson();
      const ts = args.ts ?? args.thread_ts;
      if (!ts) {
        return errorJson({
          error: 'get_slack_thread_replies requires a parent message timestamp.',
          action_required:
            'Provide ts (or the thread_ts alias) — use the ts_slack value from get_slack_channel_history.',
          next_step: 'get_slack_channel_history',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      const result = await reader.conversations.replies({
        channel: channelId,
        ts,
        limit: args.limit || 20,
        cursor: args.cursor,
      });
      const rawMessages = result.messages || [];
      const userIds = extractUserIdsFromMessages(rawMessages);
      await resolveUserIdsToCache(userIds);
      const messages = rawMessages.map((msg) =>
        enrichMessageWithUserInfo({
          ts_slack: msg.ts,
          ts_iso: msg.ts ? slackTsToDatetime(msg.ts) : undefined,
          user: msg.user,
          text: wrapUntrusted(msg.text, 'slack:thread-replies'),
          files: mapSlackFiles(msg),
        }),
      );
      const nextCursor = result.response_metadata?.next_cursor || null;
      const hasMore = !!nextCursor;
      return JSON.stringify({
        ok: true,
        messages,
        nextCursor,
        hasMore,
        ...(hasMore ? { hint: 'More results available. Use cursor parameter to fetch next page.' } : {}),
      });
    }),
  );
}
