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

  // ---------------------------------------------------------------------
  // remove_slack_reaction
  // ---------------------------------------------------------------------
  server.registerTool(
    'remove_slack_reaction',
    {
      description: `Remove your emoji reaction from a Slack message.

Only removes the connected user's own reaction — other people's reactions on
the same message are unaffected. Use list_slack_emoji to discover custom emoji
names.`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
          timestamp: z
            .string()
            .min(1)
            .describe(
              'Message timestamp — use the ts_slack value from get_slack_channel_history.',
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
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Removing reactions requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant reactions:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      await userClient.reactions.remove({
        channel: channelId,
        timestamp: args.timestamp,
        name: args.name,
      });
      return JSON.stringify({ ok: true, note: 'Reaction removed.' });
    }),
  );

  // ---------------------------------------------------------------------
  // list_slack_emoji
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_slack_emoji',
    {
      description: `List custom emoji available in the Slack workspace.

Returns a name → image-URL (or alias) map. Use the names with
add_slack_reaction / remove_slack_reaction — Slack's built-in emoji always
work without being listed here.`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Listing emoji requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant emoji:read.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const result = await userClient.emoji.list();
      const emoji = result.emoji || {};
      const entries = Object.entries(emoji).sort(([a], [b]) => a.localeCompare(b));
      // Slack constrains custom emoji names to [a-z0-9_+-] and values to
      // slack-hosted image URLs / alias: targets, so no envelope is needed —
      // this map carries no free-form text.
      const MAX_ENTRIES = 1000;
      const truncated = entries.length > MAX_ENTRIES;
      const shown = truncated ? entries.slice(0, MAX_ENTRIES) : entries;
      return JSON.stringify({
        ok: true,
        emoji: Object.fromEntries(shown),
        count: entries.length,
        ...(truncated
          ? { note: `Workspace has ${entries.length} custom emoji; showing the first ${MAX_ENTRIES} (alphabetical).` }
          : {}),
      });
    }),
  );
}
