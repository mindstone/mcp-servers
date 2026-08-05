import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson, slackTsToDatetime, withErrorHandling } from '../utils.js';
import { getSlackReaderClient, getSlackUserClient } from '../client.js';
import {
  enrichMessageWithUserInfo,
  extractUserIdsFromMessages,
  mapSlackFiles,
  resolveChannelId,
  resolveUserIdsToCache,
} from '../helpers.js';
import { notConnectedJson } from './auth.js';
import { wrapUntrusted } from '../untrusted-content.js';

export function registerPinTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // list_slack_pins
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_slack_pins',
    {
      description: `List messages pinned in a Slack channel.

Pinned items are the channel's curated highlights — useful for "what's pinned
in #channel" meeting-prep questions.`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
        })
        .strict(),
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
      const result = await reader.pins.list({ channel: channelId });
      // The SDK types pins.list items as file pins only; message pins carry a
      // `message` object at runtime, so project through a runtime-accurate shape.
      const items = (result.items || []).map((rawItem) => {
        const item = rawItem as unknown as {
          type?: string;
          created?: number;
          created_by?: string;
          message?: {
            ts?: string;
            user?: string;
            text?: string;
            permalink?: string;
            files?: Array<{ id?: string; name?: string; mimetype?: string; size?: number }>;
          };
        };
        const msg = item.message;
        return {
          type: item.type,
          created: item.created,
          created_by: item.created_by,
          ...(msg
            ? {
                ts_slack: msg.ts,
                ts_iso: msg.ts ? slackTsToDatetime(msg.ts) : undefined,
                user: msg.user,
                text: wrapUntrusted(msg.text, 'slack:pins-list'),
                files: mapSlackFiles(msg),
                permalink: msg.permalink,
              }
            : {}),
        };
      });
      const userIds = extractUserIdsFromMessages(
        items.map((i) => ({ user: i.user, text: undefined })),
      );
      await resolveUserIdsToCache(userIds);
      const enriched = items.map((i) => enrichMessageWithUserInfo(i));
      return JSON.stringify({
        ok: true,
        channel: channelId,
        pins: enriched,
        count: enriched.length,
        ...(enriched.length === 0 ? { note: 'No pinned messages in this channel.' } : {}),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // pin_slack_message
  // ---------------------------------------------------------------------
  server.registerTool(
    'pin_slack_message',
    {
      description: `Pin a message in a Slack channel so it appears in the channel's pinned items.

Get the message timestamp from get_slack_channel_history (use the ts_slack value).`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
          timestamp: z
            .string()
            .min(1)
            .describe('Message timestamp to pin — use the ts_slack value from get_slack_channel_history.'),
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
          error: 'Pinning messages requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant pins:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      await userClient.pins.add({ channel: channelId, timestamp: args.timestamp });
      return JSON.stringify({ ok: true, channel: channelId, note: 'Message pinned.' });
    }),
  );

  // ---------------------------------------------------------------------
  // unpin_slack_message
  // ---------------------------------------------------------------------
  server.registerTool(
    'unpin_slack_message',
    {
      description: `Remove a message from a Slack channel's pinned items.

The message itself is NOT deleted — it is only removed from pinned items.
Get the message timestamp from list_slack_pins or get_slack_channel_history
(use the ts_slack value).`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
          timestamp: z
            .string()
            .min(1)
            .describe('Message timestamp to unpin — use the ts_slack value from list_slack_pins.'),
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
          error: 'Unpinning messages requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant pins:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      await userClient.pins.remove({ channel: channelId, timestamp: args.timestamp });
      return JSON.stringify({ ok: true, channel: channelId, note: 'Message unpinned.' });
    }),
  );
}
