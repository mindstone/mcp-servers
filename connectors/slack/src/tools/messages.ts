import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson, parseSlackPermalink, slackTsToDatetime, withErrorHandling } from '../utils.js';
import { getSlackClient, getSlackReaderClient, getSlackUserClient } from '../client.js';
import {
  enrichMessageWithUserInfo,
  extractUserIdsFromMessages,
  resolveChannelId,
  resolveDmRecipient,
  resolveUserIdsToCache,
} from '../helpers.js';
import { notConnectedJson } from './auth.js';
import { wrapUntrusted } from '../untrusted-content.js';

const RESPONSE_FORMAT_ENUM = z.enum(['concise', 'detailed']).optional();

export function registerMessageTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // search_slack_messages
  // ---------------------------------------------------------------------
  server.registerTool(
    'search_slack_messages',
    {
      description: `Search messages across all channels in the Slack workspace.

Requires user authorization (search:read scope). Supports Slack search modifiers:
- from:@username   — Messages from a specific user
- in:#channel      — Messages in a specific channel
- before:YYYY-MM-DD / after:YYYY-MM-DD — Date filters
- has:link / has:reaction — Content filters

Set to_me=true to prepend "to:@<your_username>" automatically.`,
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query (supports Slack modifiers)'),
        count: z.number().int().min(1).max(100).optional(),
        sort: z.enum(['score', 'timestamp']).optional(),
        sort_dir: z.enum(['asc', 'desc']).optional(),
        page: z.number().int().min(1).optional(),
        to_me: z.boolean().optional(),
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
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Search requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant the search:read user scope.',
          next_step: 'authenticate_slack_workspace',
        });
      }

      let query = args.query;
      if (args.to_me) {
        const authResult = await userClient.auth.test();
        if (authResult.user) query = `to:@${authResult.user} ${query}`;
      }
      const page = args.page || 1;
      const result = await userClient.search.messages({
        query,
        count: args.count || 20,
        sort: args.sort || 'score',
        sort_dir: args.sort_dir,
        page,
      });
      const isConcise = args.response_format === 'concise';
      const rawMatches = result.messages?.matches || [];
      const userIds = extractUserIdsFromMessages(rawMatches);
      await resolveUserIdsToCache(userIds);
      const matches = rawMatches.map((m) =>
        enrichMessageWithUserInfo({
          ts_slack: m.ts,
          ts_iso: m.ts ? slackTsToDatetime(m.ts) : undefined,
          channel: m.channel,
          user: m.user,
          text: wrapUntrusted(m.text, 'slack:search-messages'),
          ...(isConcise ? {} : { permalink: m.permalink }),
        }),
      );
      const total = result.messages?.total || 0;
      const pageCount = result.messages?.paging?.pages || 1;
      const hasMore = page < pageCount;
      return JSON.stringify({
        ok: true,
        messages: matches,
        total,
        page,
        pageCount,
        ...(hasMore ? { hint: 'More results available. Use page parameter to fetch next page.' } : {}),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // get_slack_saved_messages
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_slack_saved_messages',
    {
      description: `Get messages you've saved for later in Slack.

Uses Slack search with is:saved modifier. Requires user token with search:read scope.
Additional filters: in:#channel, from:@username, before:/after:DATE, has:link, has:reaction.`,
      inputSchema: z.object({
        query: z.string().optional(),
        count: z.number().int().min(1).max(100).optional(),
        sort: z.enum(['score', 'timestamp']).optional(),
        sort_dir: z.enum(['asc', 'desc']).optional(),
        page: z.number().int().min(1).optional(),
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
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Saved messages require user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant search:read.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      let userQuery = (args.query || '').trim();
      const query = userQuery.toLowerCase().includes('is:saved')
        ? userQuery
        : `is:saved ${userQuery}`.trim();
      const page = args.page || 1;
      const result = await userClient.search.messages({
        query,
        count: args.count || 20,
        sort: args.sort || 'timestamp',
        sort_dir: args.sort_dir || 'desc',
        page,
      });
      const isConcise = args.response_format === 'concise';
      const rawMatches = result.messages?.matches || [];
      const userIds = extractUserIdsFromMessages(rawMatches);
      await resolveUserIdsToCache(userIds);
      const matches = rawMatches.map((m) =>
        enrichMessageWithUserInfo({
          ts_slack: m.ts,
          ts_iso: m.ts ? slackTsToDatetime(m.ts) : undefined,
          channel: m.channel,
          user: m.user,
          text: wrapUntrusted(m.text, 'slack:search-messages-to-me'),
          ...(isConcise ? {} : { permalink: m.permalink }),
        }),
      );
      const total = result.messages?.total || 0;
      const pageCount = result.messages?.paging?.pages || 1;
      const hasMore = page < pageCount;
      return JSON.stringify({
        ok: true,
        messages: matches,
        total,
        page,
        pageCount,
        ...(hasMore ? { hint: 'More results available. Use page parameter to fetch next page.' } : {}),
        ...(total === 0
          ? { note: 'No saved messages found. Save messages in Slack using "Save for later".' }
          : {}),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // get_slack_message_by_link
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_slack_message_by_link',
    {
      description: `Retrieve a Slack message from its permalink URL.

Supports standard permalinks (workspace.slack.com/archives/...), thread permalinks
(?thread_ts=...), and app URLs (app.slack.com/client/...). For thread messages,
returns the message and surrounding thread context (set include_thread=false to skip).

Prefers user token (broader read access to public channels).`,
      inputSchema: z.object({
        url: z.string().url().describe('Slack message permalink URL'),
        include_thread: z.boolean().optional(),
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
      const parsed = parseSlackPermalink(args.url);
      if (!parsed) {
        return errorJson({
          error: 'Invalid Slack message URL',
          action_required: 'Provide a Slack permalink URL (right-click a message → Copy link).',
          next_step: 'retry_with_valid_url',
          supported_formats: [
            'https://workspace.slack.com/archives/CHANNEL/pTIMESTAMP',
            'https://app.slack.com/client/TEAM/CHANNEL/pTIMESTAMP',
            'Thread URLs with ?thread_ts=... parameter',
          ],
        });
      }
      const includeThread = args.include_thread !== false;
      if (parsed.threadTs) {
        let cursor: string | undefined;
        let pagesSearched = 0;
        const MAX_PAGES = 5;
        const threadContext: Array<{
          ts_slack?: string;
          ts_iso?: string;
          user?: string;
          text?: string;
          bot_id?: string;
          subtype?: string;
        }> = [];
        let found: (typeof threadContext)[number] | undefined;
        do {
          const result = await reader.conversations.replies({
            channel: parsed.channelId,
            ts: parsed.threadTs,
            limit: 100,
            cursor,
          });
          const pageMessages = (result.messages || []).map((m) => ({
            ts_slack: m.ts,
            ts_iso: m.ts ? slackTsToDatetime(m.ts) : undefined,
            user: m.user,
            text: wrapUntrusted(m.text, 'slack:get-message-by-permalink:thread'),
            bot_id: (m as unknown as { bot_id?: string }).bot_id,
            subtype: (m as unknown as { subtype?: string }).subtype,
          }));
          found = pageMessages.find((m) => m.ts_slack === parsed.messageTs);
          if (includeThread) threadContext.push(...pageMessages);
          if (found) break;
          cursor = result.response_metadata?.next_cursor || undefined;
          pagesSearched += 1;
        } while (cursor && pagesSearched < MAX_PAGES);

        if (!found) {
          return errorJson({
            error: 'Message not found in thread',
            action_required:
              'The thread may be deeper than the scanned replies. Use get_slack_thread_replies with pagination.',
            next_step: 'get_slack_thread_replies',
            channel: parsed.channelId,
            requested_ts: parsed.messageTs,
            thread_ts_slack: parsed.threadTs,
          });
        }
        const allMessages = includeThread ? threadContext : [found];
        const userIds = extractUserIdsFromMessages(allMessages);
        await resolveUserIdsToCache(userIds);
        return JSON.stringify({
          ok: true,
          url: args.url,
          channel: parsed.channelId,
          is_thread_reply: true,
          thread_ts_slack: parsed.threadTs,
          thread_ts_iso: slackTsToDatetime(parsed.threadTs),
          message: enrichMessageWithUserInfo(found),
          ...(includeThread
            ? { thread_context: threadContext.map((m) => enrichMessageWithUserInfo(m)) }
            : {}),
        });
      }

      const result = await reader.conversations.history({
        channel: parsed.channelId,
        latest: parsed.messageTs,
        oldest: parsed.messageTs,
        inclusive: true,
        limit: 1,
      });
      const message = result.messages?.[0];
      if (!message || message.ts !== parsed.messageTs) {
        return errorJson({
          error: 'Message not found',
          action_required: 'Verify the permalink is correct and the bot has access to the channel.',
          next_step: 'list_slack_channels',
          channel: parsed.channelId,
          requested_ts: parsed.messageTs,
        });
      }
      const msgForEnrich = {
        ts_slack: message.ts,
        ts_iso: message.ts ? slackTsToDatetime(message.ts) : undefined,
        user: message.user,
        text: wrapUntrusted(message.text, 'slack:get-message-by-permalink'),
        bot_id: (message as unknown as { bot_id?: string }).bot_id,
        subtype: (message as unknown as { subtype?: string }).subtype,
      };
      const userIds = extractUserIdsFromMessages([msgForEnrich]);
      await resolveUserIdsToCache(userIds);
      return JSON.stringify({
        ok: true,
        url: args.url,
        channel: parsed.channelId,
        is_thread_reply: false,
        message: enrichMessageWithUserInfo(msgForEnrich),
        thread_ts_slack: message.thread_ts,
        thread_ts_iso: message.thread_ts ? slackTsToDatetime(message.thread_ts) : undefined,
        reply_count: message.reply_count,
      });
    }),
  );

  // ---------------------------------------------------------------------
  // post_slack_message
  // ---------------------------------------------------------------------
  server.registerTool(
    'post_slack_message',
    {
      description: `Post a message to a Slack channel as yourself.

DM SAFETY: For direct messages (D... channels), this tool verifies the recipient
identity before sending. Always provide intended_recipient (User ID) for DMs to
enable mismatch detection. The message is NOT sent if intended_recipient does not
match the actual DM recipient.

PARAMETERS: channel, text, intended_recipient. Do not use channel_id or message —
these are not the parameter names.

Posted as the user — messages are editable in Slack.`,
      inputSchema: z
        .object({
          channel: z
            .string()
            .min(1)
            .describe('Channel target — channel ID (e.g., C1234567890) or #channel-name (e.g., #general)'),
          text: z.string().min(1).describe('Message text (supports Slack markdown)'),
          intended_recipient: z
            .string()
            .optional()
            .describe(
              'For DMs only: expected recipient User ID. If the DM channel belongs to a different user, the message is NOT sent.',
            ),
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
          error: 'Posting messages requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant chat:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      const intendedRecipient = args.intended_recipient;
      const isDmChannel = channelId.startsWith('D');
      let dmRecipient = null;
      if (isDmChannel) {
        const verifyClient = userClient || (await getSlackClient());
        if (!verifyClient) return notConnectedJson();
        dmRecipient = await resolveDmRecipient(verifyClient, channelId);
        if (!dmRecipient) {
          return errorJson({
            error: 'Could not verify DM recipient.',
            action_required:
              'Use open_slack_dm with a verified User ID to get a valid DM channel.',
            next_step: 'open_slack_dm',
            channel: channelId,
          });
        }
        if (intendedRecipient) {
          const normalizedIntended = intendedRecipient.toUpperCase();
          const normalizedActual = dmRecipient.user_id.toUpperCase();
          if (normalizedIntended !== normalizedActual) {
            return errorJson({
              error: 'RECIPIENT MISMATCH — message NOT sent.',
              action_required:
                'Use lookup_user_by_email to get the correct user ID, then open_slack_dm to get their DM channel.',
              next_step: 'lookup_user_by_email',
              intended_recipient: intendedRecipient,
              actual_recipient: {
                user_id: dmRecipient.user_id,
                real_name: dmRecipient.real_name,
                display_name: dmRecipient.display_name,
                ...(dmRecipient.email ? { email: dmRecipient.email } : {}),
              },
              channel: channelId,
            });
          }
        }
      }

      const result = await userClient.chat.postMessage({
        channel: channelId,
        text: args.text,
      });
      return JSON.stringify({
        ok: true,
        channel: result.channel,
        ts_slack: result.ts,
        ts_iso: result.ts ? slackTsToDatetime(result.ts) : undefined,
        text: result.message?.text,
        ...(dmRecipient
          ? {
              recipient: {
                user_id: dmRecipient.user_id,
                real_name: dmRecipient.real_name,
                display_name: dmRecipient.display_name,
                ...(dmRecipient.email ? { email: dmRecipient.email } : {}),
              },
            }
          : {}),
        ...(isDmChannel && !intendedRecipient
          ? {
              warning:
                'DM sent without intended_recipient verification. For safety, always provide intended_recipient (User ID) when sending DMs.',
            }
          : {}),
        note: isDmChannel
          ? `Message sent to ${dmRecipient?.display_name || dmRecipient?.real_name || 'DM recipient'}. Posted as you.`
          : 'Posted as you — you can edit this message in Slack.',
      });
    }),
  );

  // ---------------------------------------------------------------------
  // reply_to_slack_thread
  // ---------------------------------------------------------------------
  server.registerTool(
    'reply_to_slack_thread',
    {
      description: `Reply to an existing message thread in Slack as yourself.

PARAMETERS: channel, thread_ts, text. The thread_ts comes from ts_slack /
thread_ts_slack on a message returned by get_slack_channel_history.`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
          thread_ts: z
            .string()
            .min(1)
            .describe(
              'Parent message timestamp — input key is thread_ts (not ts or timestamp). Use ts_slack value from get_slack_channel_history.',
            ),
          text: z.string().min(1).describe('Reply text'),
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
          error: 'Replying to threads requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant chat:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      const result = await userClient.chat.postMessage({
        channel: channelId,
        thread_ts: args.thread_ts,
        text: args.text,
      });
      return JSON.stringify({
        ok: true,
        channel: result.channel,
        ts_slack: result.ts,
        ts_iso: result.ts ? slackTsToDatetime(result.ts) : undefined,
        note: 'Replied as you — you can edit this message in Slack.',
      });
    }),
  );

  // ---------------------------------------------------------------------
  // schedule_slack_message
  // ---------------------------------------------------------------------
  server.registerTool(
    'schedule_slack_message',
    {
      description: `Schedule a message to be posted at a future time.

post_at is a Unix timestamp in SECONDS (not ms). Max 30 scheduled messages per
channel per 5 minutes. Max 120 days in advance.`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel — channel ID or #channel-name'),
          text: z.string().min(1).describe('Message text (supports Slack markdown)'),
          post_at: z
            .number()
            .int()
            .min(1)
            .describe('Unix timestamp IN SECONDS (not ms) for when to post'),
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
          error: 'Scheduling messages requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant chat:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (args.post_at < nowSeconds) {
        return errorJson({
          error: 'post_at must be in the future',
          action_required:
            'Use a Unix timestamp in SECONDS that is greater than the current time.',
          next_step: 'retry_with_future_timestamp',
          received: args.post_at,
          current_time: nowSeconds,
        });
      }
      if (args.post_at > nowSeconds * 1000) {
        return errorJson({
          error: 'post_at appears to be in milliseconds, not seconds',
          action_required: `Convert to seconds — try ${Math.floor(args.post_at / 1000)} instead.`,
          next_step: 'retry_with_seconds',
          received: args.post_at,
        });
      }
      const result = await userClient.chat.scheduleMessage({
        channel: channelId,
        text: args.text,
        post_at: args.post_at,
      });
      const scheduledFor = new Date(args.post_at * 1000).toISOString();
      return JSON.stringify({
        ok: true,
        channel: result.channel,
        scheduled_message_id: result.scheduled_message_id,
        post_at: args.post_at,
        post_at_iso: scheduledFor,
        message: `Message scheduled for ${scheduledFor}`,
      });
    }),
  );
}
