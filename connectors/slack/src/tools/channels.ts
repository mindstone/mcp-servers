import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson, slackTsToDatetime, withErrorHandling } from '../utils.js';
import { getSlackReaderClient, getSlackUserClient } from '../client.js';
import {
  enrichMessageWithUserInfo,
  extractUserIdsFromMessages,
  resolveChannelId,
  resolveUserIdsToCache,
} from '../helpers.js';
import { notConnectedJson } from './auth.js';
import { wrapUntrusted } from '../untrusted-content.js';

const RESPONSE_FORMAT_ENUM = z.enum(['concise', 'detailed']).optional();

export function registerChannelTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // list_slack_channels
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_slack_channels',
    {
      description: `List all channels in the connected Slack workspace.

WARNING: channel_name filter only applies to the current page. For workspaces
with 100+ channels, use list_slack_channels with limit=1000 and paginate via
cursor, OR pass #channel-name directly to get_slack_channel_history (which
auto-paginates the lookup).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(1000).optional(),
        types: z.string().optional().describe('public_channel,private_channel,mpim,im'),
        cursor: z.string().optional(),
        channel_name: z
          .string()
          .optional()
          .describe('Filter by name (case-insensitive partial match) — current page only'),
        response_format: RESPONSE_FORMAT_ENUM,
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
      const result = await reader.conversations.list({
        limit: args.limit || 100,
        types: args.types || 'public_channel',
        cursor: args.cursor,
      });
      const isConcise = args.response_format === 'concise';
      const channelNameFilter = args.channel_name?.toLowerCase();
      let channels = result.channels?.map((ch) => ({
        id: ch.id,
        name: ch.name,
        ...(isConcise
          ? {}
          : {
              is_private: ch.is_private,
              num_members: ch.num_members,
              topic: wrapUntrusted(ch.topic?.value, 'slack:list-channels:topic'),
              purpose: wrapUntrusted(ch.purpose?.value, 'slack:list-channels:purpose'),
            }),
      }));
      if (channelNameFilter && channels) {
        channels = channels.filter((ch) => ch.name?.toLowerCase().includes(channelNameFilter));
      }
      const nextCursor = result.response_metadata?.next_cursor || null;
      const hasMore = !!nextCursor;
      let hint: string | undefined;
      if (hasMore && args.channel_name) {
        const matchCount = channels?.length || 0;
        if (matchCount === 0) {
          hint =
            'NO MATCHES on this page; more pages exist. Either pass #channel-name to get_slack_channel_history (auto-paginates), set limit=1000, or paginate via cursor.';
        } else {
          hint =
            'Filter applied to current page only. More results exist on later pages that may also match.';
        }
      } else if (hasMore) {
        hint = 'More results available. Use cursor to fetch the next page.';
      }
      return JSON.stringify({
        ok: true,
        channels,
        nextCursor,
        hasMore,
        ...(hint ? { hint } : {}),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // get_slack_channel_history
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_slack_channel_history',
    {
      description: `Get recent messages from a Slack channel.

Channel input: channel ID (e.g., C1234567890) or #channel-name (e.g., #general).
If #name lookup fails, call list_slack_channels(limit:1000), paginate, then pass
the channel id here.

Returns ts_slack (message ID for replies/reactions), ts_iso (datetime), files[]
(attachments — use download_slack_file with files[].id), and thread info.

Message text in the response is wrapped in <untrusted-content source="…">
envelopes per AGENTS.md invariant #6 — do not strip them.`,
      inputSchema: z.object({
        channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
        response_format: RESPONSE_FORMAT_ENUM,
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
      const result = await reader.conversations.history({
        channel: channelId,
        limit: args.limit || 20,
        cursor: args.cursor,
      });
      const isConcise = args.response_format === 'concise';
      const rawMessages = result.messages || [];
      const userIds = extractUserIdsFromMessages(rawMessages);
      await resolveUserIdsToCache(userIds);
      const messages = rawMessages.map((msg) =>
        enrichMessageWithUserInfo({
          ts_slack: msg.ts,
          ts_iso: msg.ts ? slackTsToDatetime(msg.ts) : undefined,
          user: msg.user,
          text: wrapUntrusted(msg.text, 'slack:channel-history'),
          thread_ts_slack: msg.thread_ts,
          thread_ts_iso: msg.thread_ts ? slackTsToDatetime(msg.thread_ts) : undefined,
          ...(isConcise ? {} : { reply_count: msg.reply_count }),
          ...(isConcise
            ? {}
            : {
                files:
                  (
                    msg as {
                      files?: Array<{ id?: string; name?: string; mimetype?: string; size?: number }>;
                    }
                  ).files?.map((f) => ({
                    id: f.id,
                    name: f.name,
                    mimetype: f.mimetype,
                    size: f.size,
                  })) || undefined,
              }),
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

  // ---------------------------------------------------------------------
  // create_slack_channel
  // ---------------------------------------------------------------------
  server.registerTool(
    'create_slack_channel',
    {
      description: `Create a new Slack channel.

Channel names: lowercase only, letters/numbers/hyphens/underscores, max ~80 chars.
Note: name_taken includes archived channels. Workspace settings may prevent creation.`,
      inputSchema: z
        .object({
          name: z.string().min(1).max(80).describe('Channel name (lowercase)'),
          is_private: z.boolean().optional(),
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
          error: 'Creating channels requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant channels:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const name = args.name.toLowerCase();
      const isPrivate = args.is_private === true;
      const result = await userClient.conversations.create({
        name,
        is_private: isPrivate,
      });
      return JSON.stringify({
        ok: true,
        channel: {
          id: result.channel?.id,
          name: result.channel?.name,
          is_private: result.channel?.is_private,
        },
        message: `Created ${isPrivate ? 'private' : 'public'} channel #${result.channel?.name}`,
      });
    }),
  );

  // ---------------------------------------------------------------------
  // mark_slack_channel_as_read
  // ---------------------------------------------------------------------
  server.registerTool(
    'mark_slack_channel_as_read',
    {
      description: `Mark messages in a channel as read up to a specific timestamp.

Updates YOUR read position, not the bot's. Pass the ts of the last message you've
read. For private channels/DMs, set include_private=true.`,
      inputSchema: z.object({
        channel: z
          .string()
          .min(1)
          .describe('Channel — channel ID (C... / D... for DMs) or #channel-name'),
        ts: z
          .string()
          .min(1)
          .describe(
            'Timestamp to mark as read up to — input key is ts (not thread_ts or timestamp). Use ts_slack from a message.',
          ),
        include_private: z.boolean().optional(),
        // legacy alias for compat with old callers
        includePrivate: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        // Mutates the user's per-workspace read state (visible to other tools
        // and to the user's own Slack client). Idempotent — marking the same
        // ts twice is a no-op — but still a mutation.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Mark as read requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant the required scopes.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);

      // Honour both include_private and legacy includePrivate; if both are
      // present and conflicting, refuse the call (avoid silent wrong-default).
      let includePrivate: boolean;
      if (args.include_private !== undefined && args.includePrivate !== undefined) {
        if (args.include_private !== args.includePrivate) {
          return errorJson({
            error: 'Conflicting include_private / includePrivate values supplied.',
            action_required:
              'Set include_private: true if you need to mark private channels or DMs as read.',
            next_step: 'retry_with_consistent_args',
            suggestion:
              'Set include_private: true if you need to mark private channels or DMs as read.',
          });
        }
        includePrivate = args.include_private === true;
      } else {
        includePrivate = (args.include_private ?? args.includePrivate) === true;
      }

      const ts = args.ts;
      if (!/^\d{10}\.\d{1,6}$/.test(ts) && !/^\d{16}$/.test(ts)) {
        return errorJson({
          error: 'Invalid timestamp format. Expected: "1234567890.123456"',
          action_required: 'Use the ts_slack field from a message.',
          next_step: 'get_slack_channel_history',
        });
      }
      const normalizedTs = ts.includes('.') ? ts : `${ts.slice(0, 10)}.${ts.slice(10)}`;
      const channelInfo = await userClient.conversations.info({ channel: channelId });
      const ch = channelInfo.channel;
      const isPrivate = ch?.is_im || ch?.is_mpim || ch?.is_private;
      const channelType = ch?.is_im
        ? 'DM'
        : ch?.is_mpim
          ? 'group DM'
          : ch?.is_private
            ? 'private channel'
            : 'channel';
      if (isPrivate && !includePrivate) {
        return errorJson({
          error: `This is a ${channelType}. Private channel and DM access is restricted by default.`,
          action_required:
            'Set include_private: true if you need to mark private channels or DMs as read.',
          next_step: 'retry_with_include_private',
          suggestion:
            'Set include_private: true if you need to mark private channels or DMs as read.',
          channelType,
        });
      }
      await userClient.conversations.mark({ channel: channelId, ts: normalizedTs });
      return JSON.stringify({
        ok: true,
        message: `Marked ${channelType} as read up to ${normalizedTs}`,
        channel: channelId,
        marked_at_slack: normalizedTs,
        marked_at_iso: slackTsToDatetime(normalizedTs),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // get_slack_unread_messages
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_slack_unread_messages',
    {
      description: `Get unread messages in a channel based on your read position.

Requires user authorization. Bot-only connections cannot track unread state.
For private channels/DMs, set include_private=true (default false for safety).
Returns most-recent-unread-first.`,
      inputSchema: z.object({
        channel: z
          .string()
          .min(1)
          .describe('Channel — channel ID or #channel-name. DMs require channel ID.'),
        limit: z.number().int().min(1).max(100).optional(),
        include_private: z.boolean().optional(),
        includePrivate: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Unread messages require user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace with personal account.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      const limit = Math.min(args.limit || 50, 100);

      // Honour both include_private and legacy includePrivate
      let includePrivate: boolean;
      if (args.include_private !== undefined && args.includePrivate !== undefined) {
        if (args.include_private !== args.includePrivate) {
          return errorJson({
            error: 'Conflicting include_private / includePrivate values supplied.',
            action_required:
              'Set include_private: true if you need to access private channels or DMs for this task.',
            next_step: 'retry_with_consistent_args',
            suggestion:
              'Set include_private: true if you need to access private channels or DMs for this task.',
          });
        }
        includePrivate = args.include_private === true;
      } else {
        includePrivate = (args.include_private ?? args.includePrivate) === true;
      }

      let channelInfo;
      let channelType = 'channel';
      let isPrivate = false;
      try {
        channelInfo = await userClient.conversations.info({
          channel: channelId,
          include_num_members: true,
          // include_membership not in SDK types but required for last_read
        } as Parameters<typeof userClient.conversations.info>[0] & {
          include_membership?: boolean;
        });
        const ch = channelInfo.channel;
        if (ch?.is_im) {
          channelType = 'DM';
          isPrivate = true;
        } else if (ch?.is_mpim) {
          channelType = 'group DM';
          isPrivate = true;
        } else if (ch?.is_private) {
          channelType = 'private channel';
          isPrivate = true;
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes('channel_not_found')) {
          return errorJson({
            error: `Channel "${args.channel}" not found.`,
            action_required:
              'Verify the channel ID, or use list_slack_channels to find valid channels.',
            next_step: 'list_slack_channels',
          });
        }
        if (errMsg.includes('missing_scope') || errMsg.includes('no_permission')) {
          return errorJson({
            error: 'Cannot access this channel — insufficient permissions.',
            action_required:
              'Use get_slack_channel_history with a channel ID, or reconnect Slack with broader scopes.',
            next_step: 'authenticate_slack_workspace',
          });
        }
        if (
          errMsg.includes('not_authed') ||
          errMsg.includes('invalid_auth') ||
          errMsg.includes('token_revoked')
        ) {
          return errorJson({
            error: 'Slack authentication has expired or is invalid.',
            action_required: 'Reconnect Slack via authenticate_slack_workspace.',
            next_step: 'authenticate_slack_workspace',
          });
        }
        throw error;
      }

      if (isPrivate && !includePrivate) {
        return errorJson({
          error: `This is a ${channelType}. Private channel and DM access is restricted by default.`,
          action_required:
            'Set include_private: true if you need to access private channels or DMs for this task.',
          next_step: 'retry_with_include_private',
          suggestion:
            'Set include_private: true if you need to access private channels or DMs for this task.',
          channelType,
        });
      }

      const lastRead = channelInfo.channel?.last_read;
      const totalUnread = (channelInfo.channel as { unread_count?: number } | undefined)
        ?.unread_count;

      if (!lastRead) {
        const result = await userClient.conversations.history({ channel: channelId, limit });
        const rawMessages = result.messages || [];
        const userIds = extractUserIdsFromMessages(rawMessages);
        await resolveUserIdsToCache(userIds);
        const messages = rawMessages.map((msg) =>
          enrichMessageWithUserInfo({
            ts_slack: msg.ts,
            ts_iso: msg.ts ? slackTsToDatetime(msg.ts) : undefined,
            user: msg.user,
            text: wrapUntrusted(msg.text, 'slack:get-unread-messages:fallback'),
            thread_ts_slack: msg.thread_ts,
            thread_ts_iso: msg.thread_ts ? slackTsToDatetime(msg.thread_ts) : undefined,
            ...(msg.reactions ? { reactions: msg.reactions } : {}),
          }),
        );
        return JSON.stringify({
          ok: true,
          fallback: true,
          fallbackReason: `Unread position not available for this ${channelType}. Showing recent messages instead.`,
          messages,
          hasMore: result.has_more || false,
        });
      }

      const result = await userClient.conversations.history({
        channel: channelId,
        oldest: lastRead,
        inclusive: false,
        limit,
      });
      const rawMessages = result.messages || [];
      const userIds = extractUserIdsFromMessages(rawMessages);
      await resolveUserIdsToCache(userIds);
      const messages = rawMessages.map((msg) =>
        enrichMessageWithUserInfo({
          ts_slack: msg.ts,
          ts_iso: msg.ts ? slackTsToDatetime(msg.ts) : undefined,
          user: msg.user,
          text: wrapUntrusted(msg.text, 'slack:get-unread-messages'),
          thread_ts_slack: msg.thread_ts,
          thread_ts_iso: msg.thread_ts ? slackTsToDatetime(msg.thread_ts) : undefined,
          ...(msg.reactions ? { reactions: msg.reactions } : {}),
        }),
      );
      return JSON.stringify({
        ok: true,
        unreadCount: messages.length,
        totalUnread: totalUnread ?? null,
        last_read_ts_slack: lastRead,
        last_read_ts_iso: lastRead ? slackTsToDatetime(lastRead) : undefined,
        messages,
        hasMore: result.has_more || false,
        ...(messages.length === 0 ? { hint: 'No unread messages in this channel.' } : {}),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // invite_user_to_channel
  // ---------------------------------------------------------------------
  server.registerTool(
    'invite_user_to_channel',
    {
      description: `Add one or more users to a Slack channel.

Resolve emails to IDs first via lookup_user_by_email, then pass comma-separated
IDs (max 1000). force=true (default) continues inviting valid users when some IDs
are invalid.`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
          users: z
            .string()
            .min(1)
            .describe('User ID(s) — single ID or comma-separated list (max 1000)'),
          force: z.boolean().optional(),
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
          error: 'Inviting users requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant channel-management permissions.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      const force = args.force !== false;
      const result = await userClient.conversations.invite({
        channel: channelId,
        users: args.users,
        force,
      });
      const response: Record<string, unknown> = {
        ok: true,
        channel: result.channel?.id,
        channel_name: result.channel?.name,
        message: 'Successfully invited user(s) to channel',
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyResult = result as any;
      if (anyResult.errors && anyResult.errors.length > 0) {
        response.partial_failures = anyResult.errors;
        response.warning = 'Some users could not be invited (see partial_failures)';
      }
      return JSON.stringify(response);
    }),
  );
}
