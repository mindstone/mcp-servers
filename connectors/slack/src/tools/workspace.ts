import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson, withErrorHandling } from '../utils.js';
import { getSlackUserClient } from '../client.js';
import { resolveChannelId } from '../helpers.js';

export function registerWorkspaceTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // add_slack_bookmark
  // ---------------------------------------------------------------------
  server.registerTool(
    'add_slack_bookmark',
    {
      description: `Add a bookmark link to a channel's bookmarks bar.

Max 100 bookmarks per channel. Useful for pinning important links like project
docs, dashboards, or meeting notes.`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
          title: z.string().min(1).describe('Bookmark title'),
          link: z.string().url().describe('URL to bookmark'),
          emoji: z.string().optional().describe('Optional emoji for the bookmark (e.g., :link:)'),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Adding bookmarks requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant bookmarks:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      const result = await userClient.bookmarks.add({
        channel_id: channelId,
        title: args.title,
        type: 'link',
        link: args.link,
        ...(args.emoji ? { emoji: args.emoji } : {}),
      });
      return JSON.stringify({
        ok: true,
        bookmark: {
          id: result.bookmark?.id,
          channel: result.bookmark?.channel_id,
          channel_id: result.bookmark?.channel_id,
          title: result.bookmark?.title,
          link: result.bookmark?.link,
          emoji: result.bookmark?.emoji,
        },
        message: `Added bookmark "${args.title}" to channel`,
      });
    }),
  );

  // ---------------------------------------------------------------------
  // add_slack_reminder
  // ---------------------------------------------------------------------
  server.registerTool(
    'add_slack_reminder',
    {
      description: `[EXPERIMENTAL] Create a reminder for yourself or another user.

Slack's reminders API has been partially deprecated since 2023 ("Save it for
Later"). May become unreliable or stop working. For reliable timed messages,
prefer schedule_slack_message.

The 'time' parameter accepts a Unix timestamp (seconds) or natural language like
"in 2 hours", "tomorrow at 9am", "next Monday".`,
      inputSchema: z
        .object({
          text: z.string().min(1).describe('Reminder text'),
          time: z
            .string()
            .min(1)
            .describe(
              'When to remind: Unix timestamp (seconds) or natural language ("in 2 hours", "tomorrow at 9am").',
            ),
          user: z.string().optional().describe('User ID to remind (optional, defaults to yourself)'),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Adding reminders requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant reminders:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const result = await userClient.reminders.add({
        text: args.text,
        time: args.time,
        ...(args.user ? { user: args.user } : {}),
      });
      return JSON.stringify({
        ok: true,
        reminder: {
          id: result.reminder?.id,
          text: result.reminder?.text,
          time: result.reminder?.time,
          complete_ts: result.reminder?.complete_ts,
        },
        warning:
          "EXPERIMENTAL: Slack's reminders API may be deprecated. Consider schedule_slack_message for reliable timed messages.",
      });
    }),
  );
}
