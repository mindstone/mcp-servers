import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { slackTsToDatetime, withErrorHandling } from '../utils.js';
import { getSlackReaderClient } from '../client.js';
import {
  enrichMessageWithUserInfo,
  extractUserIdsFromMessages,
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

Get ts_slack from a message with reply_count > 0 (the thread parent).`,
      inputSchema: z.object({
        channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
        ts: z
          .string()
          .min(1)
          .describe(
            'Parent message timestamp — input key is ts (not thread_ts or timestamp). Use ts_slack from get_slack_channel_history.',
          ),
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
      const channelId = await resolveChannelId(args.channel);
      const result = await reader.conversations.replies({
        channel: channelId,
        ts: args.ts,
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
