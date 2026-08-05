import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { errorJson, parseSlackPermalink, slackTsToDatetime, withErrorHandling } from '../utils.js';
import { getSlackClient, getSlackReaderClient, getSlackUserClient } from '../client.js';
import {
  enrichMessageWithUserInfo,
  extractUserIdsFromMessages,
  mapSlackFiles,
  resolveAuthedUserId,
  resolveChannelId,
  resolveDmRecipient,
  resolveUserIdsToCache,
} from '../helpers.js';
import { notConnectedJson } from './auth.js';
import { wrapUntrusted } from '../untrusted-content.js';

const RESPONSE_FORMAT_ENUM = z.enum(['concise', 'detailed']).optional();

/**
 * `ui://` resource URI the compose_slack_message iframe is served under. The
 * shared compose-app template posts `post_slack_message` when the user clicks
 * Send; the HTML twin lives in src/resources/compose-message-template.ts
 * (generated from the shared compose-app package, drift-gated).
 */
export const COMPOSE_MESSAGE_RESOURCE_URI = 'ui://slack/compose-message';

const ANSI_ESCAPE_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const HTML_TAG_PATTERN = /<[^>]*>/g;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sanitizeViewSummaryPart(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '').replace(HTML_TAG_PATTERN, '').trim();
}

function normalizeSlackUserId(userId: string): string {
  return userId.trim().toUpperCase();
}

function selfDmRedirectJson(channel: string, recipientUserId: string): string {
  return errorJson({
    error: 'Self-DM message NOT sent.',
    action_required:
      'Use send_myself_a_note instead. It notifies you with a direct message from the Slack app, and it is separate from your own Slack notes-to-self space.',
    next_step: 'send_myself_a_note',
    channel,
    actual_recipient: recipientUserId,
  });
}

function unknownAuthedUserJson(channel: string): string {
  return errorJson({
    error: 'Could not verify whether this DM is your own self-DM, so the message was NOT sent.',
    action_required:
      'Reconnect Slack via authenticate_slack_workspace so your Slack user identity can be verified before sending DMs.',
    next_step: 'authenticate_slack_workspace',
    channel,
  });
}

// ---------------------------------------------------------------------
// Search backend selection: Real-Time Search API with loud legacy fallback
// ---------------------------------------------------------------------
// Slack's Real-Time Search API (`assistant.search.context`, launched Feb
// 2026) superseded legacy `search.messages` — Slack's own usage guidelines
// say "DON'T use the legacy `search:read` scope and related search.messages".
// But RTS requires the granular `search:read.*` scopes, which a connected
// Slack app may not have been granted yet (granting them is the host's OAuth
// consent decision, not something this connector can force). So the backend
// is probed per workspace: the first search call tries RTS; a scope/feature
// refusal flips the process to the legacy endpoint — loudly. Every response
// carries `search_backend`, and legacy responses add a `search_backend_note` naming the
// refusal, so the degradation is never silent.

type SearchBackend = 'assistant.search.context' | 'search.messages';

/**
 * Slack error codes that mean "RTS cannot work with this token/install" (as
 * opposed to transient failures, which must surface as errors). On any of
 * these we cache the legacy backend for the process lifetime; re-auth with
 * the granular scopes restarts the probe because the cache is keyed by team
 * and a token-refresh does not add scopes.
 */
const RTS_FALLBACK_ERROR_CODES: ReadonlySet<string> = new Set([
  'missing_scope',
  'not_allowed_token_type',
  'feature_not_enabled',
  'access_denied',
  'deprecated_endpoint',
  'method_deprecated',
]);

/**
 * RTS is cursor-paginated with a tight per-user rate limit (~10 req/min), so
 * satisfying a legacy-style `page` parameter costs one API call per page.
 * Deep walks are capped; beyond the cap the deepest fetched page is returned
 * with `page_walk_truncated: true`.
 */
const MAX_RTS_PAGE_WALKS = 5;

const searchBackendCache = new Map<string, SearchBackend>();

/** Test-only: reset the per-workspace backend probe cache. */
export function _resetSearchBackendCache(): void {
  searchBackendCache.clear();
}

function slackErrorDataCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const code = (data as { error?: unknown }).error;
  return typeof code === 'string' ? code : null;
}

interface MessageSearchQuery {
  query: string;
  count: number;
  sort: 'score' | 'timestamp';
  sort_dir?: 'asc' | 'desc';
  page: number;
}

/** Backend-neutral projection of one search hit (legacy search.messages shape). */
interface NormalizedSearchMatch {
  ts?: string;
  channel?: { id?: string; name?: string };
  user?: string;
  text?: string;
  permalink?: string;
}

interface MessageSearchResult {
  matches: NormalizedSearchMatch[];
  total: number;
  page: number;
  pageCount: number;
  hasMore: boolean;
  backend: SearchBackend;
  /** Slack error code that forced the legacy fallback, when observed. */
  fallbackReason?: string;
  pageWalkTruncated?: boolean;
}

interface RtsSearchMessage {
  author_user_id?: string;
  channel_id?: string;
  channel_name?: string;
  message_ts?: string;
  content?: string;
  permalink?: string;
}

interface RtsSearchResponse {
  results?: { messages?: RtsSearchMessage[] };
  response_metadata?: { next_cursor?: string };
}

async function searchViaRealTimeSearch(
  userClient: WebClient,
  opts: MessageSearchQuery,
): Promise<Omit<MessageSearchResult, 'backend' | 'fallbackReason'>> {
  const limit = Math.min(opts.count, 20); // RTS caps `limit` at 20.
  let cursor: string | undefined;
  let page = 0;
  let data: RtsSearchResponse = {};
  do {
    page += 1;
    // `assistant.search.context` has no typed WebClient method in this SDK
    // version; apiCall posts to the same /api/<method> endpoint.
    data = (await userClient.apiCall('assistant.search.context', {
      query: opts.query,
      limit,
      sort: opts.sort,
      ...(opts.sort_dir ? { sort_dir: opts.sort_dir } : {}),
      // Ask for every conversation type so results match the legacy "search
      // everywhere the user can see" semantics. A token missing one of the
      // granular scopes gets missing_scope → loud legacy fallback.
      channel_types: 'public_channel,private_channel,mpim,im',
      ...(cursor ? { cursor } : {}),
    })) as unknown as RtsSearchResponse;
    const nextCursor = data.response_metadata?.next_cursor;
    cursor = nextCursor ? nextCursor : undefined;
  } while (page < opts.page && cursor && page < MAX_RTS_PAGE_WALKS);
  const rawMessages = data.results?.messages ?? [];
  return {
    matches: rawMessages.map((m) => ({
      ts: m.message_ts,
      channel: { id: m.channel_id, name: m.channel_name },
      user: m.author_user_id,
      text: m.content,
      permalink: m.permalink,
    })),
    // RTS returns no total hit count; the number of matches on the final
    // fetched page is the only honest figure available.
    total: rawMessages.length,
    page,
    pageCount: cursor ? page + 1 : page,
    hasMore: Boolean(cursor),
    ...(page < opts.page ? { pageWalkTruncated: true } : {}),
  };
}

async function searchViaLegacySearchMessages(
  userClient: WebClient,
  opts: MessageSearchQuery,
): Promise<Omit<MessageSearchResult, 'backend' | 'fallbackReason'>> {
  const result = await userClient.search.messages({
    query: opts.query,
    count: opts.count,
    sort: opts.sort,
    sort_dir: opts.sort_dir,
    page: opts.page,
  });
  const rawMatches = result.messages?.matches || [];
  const pageCount = result.messages?.paging?.pages || 1;
  return {
    matches: rawMatches.map((m) => ({
      ts: m.ts,
      channel: m.channel,
      user: m.user,
      text: m.text,
      permalink: m.permalink,
    })),
    total: result.messages?.total || 0,
    page: opts.page,
    pageCount,
    hasMore: opts.page < pageCount,
  };
}

export async function runMessageSearch(
  userClient: WebClient,
  opts: MessageSearchQuery,
): Promise<MessageSearchResult> {
  const cacheKey = process.env.SLACK_TEAM_ID ?? 'default';
  let fallbackReason: string | undefined;
  if (searchBackendCache.get(cacheKey) !== 'search.messages') {
    try {
      const rts = await searchViaRealTimeSearch(userClient, opts);
      searchBackendCache.set(cacheKey, 'assistant.search.context');
      return { ...rts, backend: 'assistant.search.context' };
    } catch (err) {
      const code = slackErrorDataCode(err);
      if (!code || !RTS_FALLBACK_ERROR_CODES.has(code)) throw err;
      searchBackendCache.set(cacheKey, 'search.messages');
      fallbackReason = code;
      console.error(
        `[slack-mcp] Real-Time Search (assistant.search.context) unavailable for this workspace (${code}); ` +
          'falling back to legacy search.messages for this process. Grant the granular search:read.* scopes ' +
          '(search:read.public/private/im/mpim) and reconnect to enable the recommended search path.',
      );
    }
  }
  const legacy = await searchViaLegacySearchMessages(userClient, opts);
  return { ...legacy, backend: 'search.messages', ...(fallbackReason ? { fallbackReason } : {}) };
}

/** Loud-fallback note attached to every legacy-backend search response. */
export function searchBackendNote(result: MessageSearchResult): string | undefined {
  if (result.backend !== 'search.messages') return undefined;
  const reason = result.fallbackReason
    ? `Slack returned "${result.fallbackReason}" for assistant.search.context.`
    : 'assistant.search.context was previously refused for this workspace token.';
  return (
    `DEPRECATED BACKEND IN USE: results came from legacy search.messages, which Slack officially discourages. ` +
    `${reason} To enable the recommended Real-Time Search API, reconnect Slack with the granular ` +
    `search:read.public/private/im/mpim scopes.`
  );
}


export function registerMessageTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // search_slack_messages
  // ---------------------------------------------------------------------
  server.registerTool(
    'search_slack_messages',
    {
      description: `Search messages across all channels in the Slack workspace.

Requires user authorization. Uses Slack's Real-Time Search API
(assistant.search.context) when the connected app has the granular
search:read.* scopes; otherwise falls back to legacy search.messages and says
so in the response (search_backend + search_backend_note). Supports Slack search modifiers:
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
            'Reconnect Slack via authenticate_slack_workspace to grant search scopes.',
          next_step: 'authenticate_slack_workspace',
        });
      }

      let query = args.query;
      if (args.to_me) {
        const authResult = await userClient.auth.test();
        if (authResult.user) query = `to:@${authResult.user} ${query}`;
      }
      const result = await runMessageSearch(userClient, {
        query,
        count: args.count || 20,
        sort: args.sort || 'score',
        sort_dir: args.sort_dir,
        page: args.page || 1,
      });
      const isConcise = args.response_format === 'concise';
      const rawMatches = result.matches;
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
      const note = searchBackendNote(result);
      return JSON.stringify({
        ok: true,
        messages: matches,
        total: result.total,
        page: result.page,
        pageCount: result.pageCount,
        search_backend: result.backend,
        ...(result.hasMore
          ? { hint: 'More results available. Use page parameter to fetch next page.' }
          : {}),
        ...(result.pageWalkTruncated
          ? {
              page_walk_truncated: true,
              page_walk_note: `Real-Time Search is cursor-paginated; deep page walks are capped. Showing page ${result.page} of the requested page ${args.page}.`,
            }
          : {}),
        ...(note ? { search_backend_note: note } : {}),
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

Uses Slack search with the is:saved modifier (Real-Time Search API when the
connected app has the granular search:read.* scopes, otherwise legacy
search.messages — the response says which via search_backend).
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
            'Reconnect Slack via authenticate_slack_workspace to grant search scopes.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      let userQuery = (args.query || '').trim();
      const query = userQuery.toLowerCase().includes('is:saved')
        ? userQuery
        : `is:saved ${userQuery}`.trim();
      const result = await runMessageSearch(userClient, {
        query,
        count: args.count || 20,
        sort: args.sort || 'timestamp',
        sort_dir: args.sort_dir || 'desc',
        page: args.page || 1,
      });
      const isConcise = args.response_format === 'concise';
      const rawMatches = result.matches;
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
      const note = searchBackendNote(result);
      return JSON.stringify({
        ok: true,
        messages: matches,
        total: result.total,
        page: result.page,
        pageCount: result.pageCount,
        search_backend: result.backend,
        ...(result.hasMore
          ? { hint: 'More results available. Use page parameter to fetch next page.' }
          : {}),
        ...(result.pageWalkTruncated
          ? {
              page_walk_truncated: true,
              page_walk_note: `Real-Time Search is cursor-paginated; deep page walks are capped. Showing page ${result.page} of the requested page ${args.page}.`,
            }
          : {}),
        ...(result.total === 0
          ? { note: 'No saved messages found. Save messages in Slack using "Save for later".' }
          : {}),
        ...(note ? { search_backend_note: note } : {}),
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

Messages may include files[] (attachments — each with id, name, mimetype, size);
use download_slack_file with files[].id to download an attachment.

When the linked message is a thread parent, the response includes reply_count;
call get_slack_thread_replies (with the parent ts) to read the replies.

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
          files?: Array<{ id?: string; name?: string; mimetype?: string; size?: number }>;
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
            files: mapSlackFiles(m),
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
        files: mapSlackFiles(message),
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
  // send_myself_a_note
  // ---------------------------------------------------------------------
  server.registerTool(
    'send_myself_a_note',
    {
      description: `Send yourself a Slack note that actually notifies you.

This sends a direct message from the Slack app to you, so Slack treats it as a real
notification. It is separate from your own self-DM "notes to self" space — same idea,
different conversation, fewer mysteriously silent messages.

PARAMETER: text. Use text, not message, note, or channel.`,
      inputSchema: z
        .object({
          text: z.string().min(1).describe('Note text to send to yourself. Use the text parameter, not message or note.'),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (args) => {
      const botClient = await getSlackClient();
      if (!botClient) {
        return errorJson({
          error: 'Sending yourself a note requires Slack bot authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace so the Slack app can send the notified DM.',
          next_step: 'authenticate_slack_workspace',
        });
      }

      const authedUserId = await resolveAuthedUserId();
      if (!authedUserId) {
        return errorJson({
          error: 'Could not determine your Slack user ID.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace so the Slack app knows where to send your notified note.',
          next_step: 'authenticate_slack_workspace',
        });
      }

      const result = await botClient.chat.postMessage({
        channel: authedUserId,
        text: args.text,
      });
      return JSON.stringify({
        ok: true,
        channel: result.channel,
        ts_slack: result.ts,
        ts_iso: result.ts ? slackTsToDatetime(result.ts) : undefined,
        note: 'Sent to yourself as a notified direct message from the Slack app.',
      });
    }),
  );

  // ---------------------------------------------------------------------
  // compose_slack_message
  // ---------------------------------------------------------------------
  // Returns an editable draft the host renders as an interactive compose view
  // (the compose-message iframe). Performs no chat.postMessage itself — the
  // iframe invokes post_slack_message when the user clicks Send. Registered
  // WITHOUT withErrorHandling: it does no send I/O, and its InvalidParams
  // validation must surface as-is rather than as an auth-flavoured retry
  // envelope. For a DM target (D…) it resolves the recipient User ID and rides
  // it hidden+locked into the draft so the send passes DM verification.
  server.registerTool(
    'compose_slack_message',
    {
      description: `Open an inline editable message compose form before sending to Slack. Use this when the user wants to write or send a Slack message so they can review and edit it first. Does NOT send directly — the form posts the message (via post_slack_message) when the user clicks Send.

PARAMETERS: target (channel ID, #channel-name, or a DM channel), text. For a DM target the recipient identity is resolved and locked into the draft so the send is verified.`,
      inputSchema: z
        .object({
          target: z
            .string()
            .min(1)
            .describe('Where to send — channel ID (e.g., C1234567890), #channel-name (e.g., #general), or a DM channel (D…)'),
          text: z.string().min(1).describe('Message text (supports Slack markdown)'),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      const target = typeof args.target === 'string' ? args.target.trim() : '';
      const text = typeof args.text === 'string' ? args.text : '';
      if (target.length === 0 || text.trim().length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'compose_slack_message requires a non-empty "target" (channel or person) and "text". Provide both so the editable draft has content for the user to review.',
        );
      }

      // For a DM target, resolve the recipient User ID so it can ride hidden +
      // locked into the send and pass post_slack_message's DM verification.
      // Best-effort: if resolution fails the draft still opens, but the send
      // will be refused (fail-closed) until a recipient is confirmed.
      let intendedRecipient: string | undefined;
      if (target.startsWith('D')) {
        try {
          const verifyClient = (await getSlackUserClient()) || (await getSlackClient());
          if (verifyClient) {
            const dmRecipient = await resolveDmRecipient(verifyClient, target);
            if (dmRecipient?.user_id) intendedRecipient = dmRecipient.user_id;
          }
          if (!intendedRecipient) {
            console.warn(
              `[slack-mcp] compose_slack_message could not resolve DM recipient for ${target}; the send will require confirmation.`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[slack-mcp] compose_slack_message DM recipient resolution failed: ${msg}`);
        }
      }

      const structuredContent = {
        target,
        text,
        ...(intendedRecipient ? { intended_recipient: intendedRecipient } : {}),
      };

      const viewSummaryTarget = truncateText(sanitizeViewSummaryPart(target), 120);
      const viewSummary = truncateText(`Slack message draft to ${viewSummaryTarget || '(no target)'}.`, 280);
      const fallbackTarget = truncateText(target, 256);
      const fallbackText = truncateText(text, 5_000);

      return {
        content: [
          {
            type: 'text',
            text: `Drafting a Slack message to ${target}\n\n${JSON.stringify(structuredContent)}\n\n[View: ${COMPOSE_MESSAGE_RESOURCE_URI}]`,
          },
        ],
        _meta: {
          ui: {
            resourceUri: COMPOSE_MESSAGE_RESOURCE_URI,
            presentation: 'primary',
            viewSummary,
            viewRoleLabel: 'Slack message',
            structuredFallback: {
              kind: 'plain',
              payload: {
                markdown: `Message to ${fallbackTarget}:\n\n${fallbackText}`,
              },
            },
          },
        },
        structuredContent,
      };
    },
  );

  // ---------------------------------------------------------------------
  // post_slack_message
  // ---------------------------------------------------------------------
  server.registerTool(
    'post_slack_message',
    {
      description: `Post a message to a Slack channel as yourself.

DM SAFETY: For direct messages (D... channels), intended_recipient (the recipient
User ID) is REQUIRED. Without it the message is NOT sent — a DM has no visible
recipient name, so sending unverified risks reaching the wrong person. The tool
also refuses to send if intended_recipient does not match the actual DM recipient.
To get a User ID use lookup_user_by_email, then open_slack_dm for their DM channel.

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
        // Fail-closed: a DM has no visible recipient name, so we refuse to send
        // without an intended_recipient to verify against rather than trusting
        // the channel ID resolved to the right person.
        if (!intendedRecipient) {
          return errorJson({
            error: 'DM NOT sent — intended_recipient is required for direct messages.',
            action_required:
              'Provide intended_recipient (the recipient User ID) so the DM can be verified. Use lookup_user_by_email to find the User ID, then open_slack_dm to get their DM channel.',
            next_step: 'lookup_user_by_email',
            channel: channelId,
          });
        }
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
          const normalizedIntended = normalizeSlackUserId(intendedRecipient);
          const normalizedActual = normalizeSlackUserId(dmRecipient.user_id);
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
        const authedUserId = await resolveAuthedUserId();
        if (!authedUserId) return unknownAuthedUserJson(channelId);
        if (normalizeSlackUserId(dmRecipient.user_id) === normalizeSlackUserId(authedUserId)) {
          return selfDmRedirectJson(channelId, dmRecipient.user_id);
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
      if (channelId.startsWith('D')) {
        const dmRecipient = await resolveDmRecipient(userClient, channelId);
        if (!dmRecipient) {
          return errorJson({
            error: 'Could not verify scheduled DM recipient.',
            action_required:
              'Use open_slack_dm with a verified User ID to get a valid DM channel, or schedule to a Slack channel.',
            next_step: 'open_slack_dm',
            channel: channelId,
          });
        }
        const authedUserId = await resolveAuthedUserId();
        if (!authedUserId) return unknownAuthedUserJson(channelId);
        if (normalizeSlackUserId(dmRecipient.user_id) === normalizeSlackUserId(authedUserId)) {
          return errorJson({
            error: 'Scheduled self-note NOT created.',
            action_required:
              'Scheduled self-notes are not supported yet. Use send_myself_a_note for an immediate notified note, or schedule to a channel.',
            next_step: 'send_myself_a_note',
            channel: channelId,
            actual_recipient: dmRecipient.user_id,
          });
        }
      }
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

  // ---------------------------------------------------------------------
  // list_scheduled_slack_messages
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_scheduled_slack_messages',
    {
      description: `List your pending scheduled messages (optionally filtered to one channel).

Returns each message's scheduled_message_id — pass it to
delete_scheduled_slack_message to cancel one before it posts.`,
      inputSchema: z
        .object({
          channel: z
            .string()
            .optional()
            .describe('Optional channel filter — channel ID or #channel-name'),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z
            .string()
            .optional()
            .describe('Pagination cursor from a previous response (next_cursor).'),
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
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Listing scheduled messages requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant chat:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = args.channel ? await resolveChannelId(args.channel) : undefined;
      const result = await userClient.chat.scheduledMessages.list({
        ...(channelId ? { channel: channelId } : {}),
        limit: args.limit || 50,
        ...(args.cursor ? { cursor: args.cursor } : {}),
      });
      const scheduled = (result.scheduled_messages || []).map((m) => ({
        scheduled_message_id: m.id,
        channel: m.channel_id,
        post_at: m.post_at,
        post_at_iso: m.post_at ? new Date(m.post_at * 1000).toISOString() : undefined,
        // The scheduled text is the calling user's own draft, but it round-
        // trips through Slack and may embed quoted external content — wrap it
        // like every other Slack-sourced string (invariant #6).
        text: wrapUntrusted(m.text, 'slack:scheduled-message'),
      }));
      const nextCursor = result.response_metadata?.next_cursor || undefined;
      return JSON.stringify({
        ok: true,
        scheduled_messages: scheduled,
        count: scheduled.length,
        ...(nextCursor
          ? {
              next_cursor: nextCursor,
              hint: 'More scheduled messages available. Pass next_cursor as cursor to fetch the next page.',
            }
          : {}),
        ...(scheduled.length === 0
          ? { note: 'No pending scheduled messages. Create one with schedule_slack_message.' }
          : {}),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // delete_scheduled_slack_message
  // ---------------------------------------------------------------------
  server.registerTool(
    'delete_scheduled_slack_message',
    {
      description: `Cancel a scheduled message before it posts.

Get the scheduled_message_id from list_scheduled_slack_messages (or from the
schedule_slack_message response). This cannot be undone — the message will
never be sent.`,
      inputSchema: z
        .object({
          channel: z.string().min(1).describe('Channel the message was scheduled to — channel ID or #channel-name'),
          scheduled_message_id: z
            .string()
            .min(1)
            .describe('Scheduled message ID (Q…) from list_scheduled_slack_messages'),
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
          error: 'Deleting scheduled messages requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant chat:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const channelId = await resolveChannelId(args.channel);
      await userClient.chat.deleteScheduledMessage({
        channel: channelId,
        scheduled_message_id: args.scheduled_message_id,
      });
      return JSON.stringify({
        ok: true,
        channel: channelId,
        scheduled_message_id: args.scheduled_message_id,
        note: 'Scheduled message cancelled — it will not be posted.',
      });
    }),
  );
}
