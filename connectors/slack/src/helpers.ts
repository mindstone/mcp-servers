/**
 * Slack helper utilities — user/channel resolution, user-id cache, DM
 * recipient verification. Extracted from the original index.ts so each tool
 * file is small and testable.
 */

import type { WebClient } from '@slack/web-api';
import { getSlackClient, getSlackReaderClient, getSlackUserClient, getTokenProvider } from './client.js';
import { ConnectorError, type DmRecipient } from './types.js';
import { sanitizeErrorMessage } from './utils.js';

interface CachedUser {
  name: string;
  displayName: string;
}

const userCache = new Map<string, CachedUser>();
const userLookupInFlight = new Map<string, Promise<void>>();

/**
 * Resolve the authenticated Slack user ID from the persisted token metadata,
 * falling back to a user-token `auth.test` for older token files written before
 * the host captured `authedUserId`.
 *
 * The recovery result is intentionally NOT cached at module scope: caching it
 * would go stale if the workspace re-authenticates as a different identity while
 * the (legacy) token file still lacks `authedUserId`. The persisted path is the
 * common case and already short-circuits before this network call; the recovery
 * path is a rare, cold path where re-querying `auth.test` is cheap and always
 * reflects the current user token.
 */
export async function resolveAuthedUserId(): Promise<string | undefined> {
  const persisted = await getTokenProvider()?.getAuthedUserId();
  if (persisted) return persisted;

  try {
    const userClient = await getSlackUserClient();
    if (!userClient) return undefined;
    const authResult = await userClient.auth.test();
    if (authResult.user_id) return authResult.user_id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[slack-mcp] resolveAuthedUserId recovery failed: ${sanitizeErrorMessage(msg)}`);
  }
  return undefined;
}

/**
 * Resolve user IDs into the in-memory cache. Uses parallel `users.info`
 * calls (faster than `users.list` on large workspaces). Failures are
 * non-fatal — unresolved users simply don't get enriched.
 */
export async function resolveUserIdsToCache(userIds: string[]): Promise<void> {
  const client = (await getSlackClient()) ?? (await getSlackReaderClient());
  if (!client) return;

  const uniqueIds = [...new Set(userIds.map((id) => id.toUpperCase()))];
  const inFlightPromises: Promise<void>[] = [];
  const unknownIds: string[] = [];

  for (const id of uniqueIds) {
    if (userCache.has(id)) continue;
    const inflight = userLookupInFlight.get(id);
    if (inflight) {
      inFlightPromises.push(inflight);
    } else {
      unknownIds.push(id);
    }
  }

  if (unknownIds.length === 0) {
    if (inFlightPromises.length > 0) await Promise.all(inFlightPromises);
    return;
  }

  const lookupPromise = (async () => {
    const CONCURRENCY = 5;
    for (let i = 0; i < unknownIds.length; i += CONCURRENCY) {
      const batch = unknownIds.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (id) => {
          try {
            const result = await client.users.info({ user: id });
            if (result.ok && result.user) {
              const u = result.user;
              userCache.set(id, {
                name: u.name || id,
                displayName: u.profile?.display_name || u.real_name || u.name || id,
              });
            }
          } catch {
            // Best-effort
          }
        }),
      );
    }
  })();

  for (const id of unknownIds) {
    userLookupInFlight.set(id, lookupPromise);
  }
  try {
    await Promise.all([lookupPromise, ...inFlightPromises]);
  } finally {
    for (const id of unknownIds) {
      userLookupInFlight.delete(id);
    }
  }
}

/** Extract user IDs from message bodies (author + `<@U…>` mentions). */
export function extractUserIdsFromMessages(
  messages: Array<{ user?: string; text?: string }>,
): string[] {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (msg.user && /^[UW][A-Z0-9]+$/i.test(msg.user)) ids.add(msg.user);
    if (msg.text) {
      const mentions = msg.text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/gi);
      for (const m of mentions) ids.add(m[1]);
    }
  }
  return Array.from(ids);
}

/** Add `user_name` / `user_display_name` fields when known. */
export function enrichMessageWithUserInfo<T extends { user?: string }>(
  msg: T,
): T & { user_name?: string; user_display_name?: string } {
  const cached = msg.user ? userCache.get(msg.user.toUpperCase()) : undefined;
  return {
    ...msg,
    ...(cached ? { user_name: cached.name, user_display_name: cached.displayName } : {}),
  };
}

/** Reset the user cache. Test-only. */
export function _resetUserCache(): void {
  userCache.clear();
  userLookupInFlight.clear();
}

/**
 * Resolve a channel input to a Slack channel ID. Accepts:
 *   - Channel ID (e.g., "C1234567890") → returned as-is
 *   - Slack rich format (e.g., "<#C123|name>") → ID extracted
 *   - "#channel-name" → looked up via conversations.list (paginated)
 */
export async function resolveChannelId(channelInput: string): Promise<string> {
  const client = await getSlackReaderClient();
  if (!client) {
    throw new ConnectorError(
      'Slack not connected.',
      'NOT_CONNECTED',
      'Call authenticate_slack_workspace to connect.',
    );
  }

  if (!channelInput.startsWith('#')) {
    const richMatch = channelInput.match(/^<#([A-Z0-9]+)(?:\|[^>]*)?>$/);
    if (richMatch) return richMatch[1];
    return channelInput;
  }

  const channelName = channelInput.slice(1).toLowerCase();
  let cursor: string | undefined;
  let pagesSearched = 0;
  let totalChannelsSearched = 0;

  try {
    do {
      const result = await client.conversations.list({
        limit: 200,
        exclude_archived: true,
        types: 'public_channel,private_channel',
        cursor,
      });
      pagesSearched++;
      totalChannelsSearched += result.channels?.length || 0;
      const match = result.channels?.find((ch) => ch.name?.toLowerCase() === channelName);
      if (match?.id) return match.id;
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('missing_scope')) {
      throw new ConnectorError(
        `Cannot look up channel by name — missing Slack permission (channels:read scope).`,
        'MISSING_SCOPE',
        `Use channel ID instead (e.g., C1234567890), or reconnect Slack to grant the required scope.`,
      );
    }
    if (errMsg.includes('ratelimited')) {
      throw new ConnectorError(
        `Rate limited while searching for channel.`,
        'RATE_LIMITED',
        `Try again in a moment, or use channel ID directly.`,
      );
    }
    throw new ConnectorError(
      `Failed to search for channel '${channelInput}': ${errMsg}`,
      'CHANNEL_LOOKUP_FAILED',
      `Use channel ID directly (e.g., C1234567890) instead of #channel-name.`,
    );
  }

  throw new ConnectorError(
    `Channel '${channelInput}' not found after searching ${totalChannelsSearched} channels across ${pagesSearched} pages.`,
    'CHANNEL_NOT_FOUND',
    `Use list_slack_channels to see available channels and pass the channel ID directly.`,
  );
}

/**
 * Resolve a user input to a Slack user ID. Accepts U/W IDs, `<@U123>` /
 * `<@U123|name>` formats, or `@username` / `username`.
 */
export async function resolveUserId(client: WebClient, input: string): Promise<string> {
  const mentionMatch = input.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^[UW][A-Z0-9]+$/.test(input)) return input;

  const searchName = input.replace(/^@/, '').toLowerCase();
  const matches: Array<{ id: string; name: string; matchType: string }> = [];

  for await (const page of client.paginate('users.list', {})) {
    for (const user of (page as {
      members?: Array<{
        id?: string;
        name?: string;
        deleted?: boolean;
        is_bot?: boolean;
        profile?: { display_name?: string; real_name?: string };
      }>;
    }).members || []) {
      if (user.deleted || user.is_bot) continue;
      if (user.name?.toLowerCase() === searchName) {
        matches.push({ id: user.id!, name: user.name, matchType: 'username' });
      } else if (user.profile?.display_name?.toLowerCase() === searchName) {
        matches.push({ id: user.id!, name: user.profile.display_name, matchType: 'display_name' });
      } else if (user.profile?.real_name?.toLowerCase() === searchName) {
        matches.push({ id: user.id!, name: user.profile.real_name, matchType: 'real_name' });
      }
    }
  }

  if (matches.length === 0) {
    throw new ConnectorError(
      `User not found: "${input}".`,
      'USER_NOT_FOUND',
      `Use lookup_user_by_email (preferred — exact match) or list_slack_users to find the user ID.`,
    );
  }
  if (matches.length > 1) {
    const matchList = matches.map((m) => `${m.name} (${m.matchType})`).join(', ');
    throw new ConnectorError(
      `Ambiguous user: "${input}" matches multiple users: ${matchList}.`,
      'AMBIGUOUS_USER',
      `Use the user ID directly, or lookup_user_by_email for unambiguous resolution.`,
    );
  }
  return matches[0].id;
}

/**
 * Resolve a DM channel ID to the recipient's identity. Returns null if the
 * channel is not a 1:1 DM or resolution fails.
 */
export async function resolveDmRecipient(
  client: WebClient,
  channelId: string,
): Promise<DmRecipient | null> {
  try {
    const convInfo = await client.conversations.info({ channel: channelId });
    const channel = convInfo.channel;
    if (!channel?.is_im) return null;
    const partnerId = (channel as unknown as { user?: string }).user;
    if (!partnerId) return null;
    const userInfo = await client.users.info({ user: partnerId });
    if (!userInfo.ok || !userInfo.user) return null;
    const u = userInfo.user;
    return {
      user_id: u.id!,
      real_name: u.real_name || u.name || partnerId,
      display_name: u.profile?.display_name || u.real_name || u.name || partnerId,
      email: u.profile?.email,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[slack-mcp] resolveDmRecipient failed for channel ${channelId}: ${sanitizeErrorMessage(msg)}`,
    );
    return null;
  }
}
