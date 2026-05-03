import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson, withErrorHandling } from '../utils.js';
import { getSlackUserClient } from '../client.js';
import { resolveChannelId } from '../helpers.js';

export function registerReactionTools(server: McpServer): void {
  server.registerTool(
    'add_slack_reaction',
    {
      description: `Add an emoji reaction to a Slack message as yourself.

Get the message timestamp from get_slack_channel_history (use ts_slack value).
Common reactions: thumbsup, thumbsdown, heart, eyes, white_check_mark, x.`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
          timestamp: z
            .string()
            .min(1)
            .describe(
              'Message timestamp to react to — input key is timestamp (not ts or thread_ts). Use ts_slack value from get_slack_channel_history.',
            ),
          name: z
            .string()
            .min(1)
            .describe('Emoji name without colons (e.g., thumbsup, heart, eyes)'),
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
          error: 'Adding reactions requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant reactions:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      await userClient.reactions.add({
        channel: channelId,
        timestamp: args.timestamp,
        name: args.name,
      });
      return JSON.stringify({ ok: true, note: 'Reacted as you.' });
    }),
  );
}
