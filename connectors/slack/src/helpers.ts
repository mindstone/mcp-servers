/**
 * Slack helper utilities — user/channel resolution, user-id cache, send
 * target resolution. Extracted from the original index.ts so each tool
 * file is small and testable.
 */

import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { getSlackReaderClient, getSlackUserClient, getTokenProvider, runSlackRead } from './client.js';
import { ConnectorError, type DmRecipient } from './types.js';
import { AUTH_REQUIRED_CODES, errorJson, isMissingScopeError, isTokenExpiredError, sanitizeErrorMessage } from './utils.js';
import { wrapUntrusted } from './untrusted-content.js';

/** Shape of a projected Slack file attachment surfaced in tool responses. */
export interface SlackFileProjection {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
}

/**
 * Project a Slack message's `files[]` into the `{id, name, mimetype, size}`
 * shape surfaced by the read tools. The file `name` is attacker-controlled,
 * so it is routed through `wrapUntrusted` (AGENTS.md invariant #6) — this is
 * the single chokepoint shared by every tool that emits attachments, so the
 * envelope cannot be forgotten on one call site.
 *
 * Returns `undefined` when there are no files (matching the historical
 * `... || undefined` behaviour in get_slack_channel_history, so an empty
 * `files: []` collapses to `undefined`).
 */
export function mapSlackFiles(msg: {
  files?: Array<{ id?: string; name?: string; mimetype?: string; size?: number }>;
}): SlackFileProjection[] | undefined {
  return (
    msg.files?.map((f) => ({
      id: f.id,
      name: wrapUntrusted(f.name, 'slack:file-name'),
      mimetype: f.mimetype,
      size: f.size,
    })) || undefined
  );
}

/**
 * Envelope source for text a Slack user writes into their own profile
 * (display name, real name, title, status text, phone). Handles, ids, emails
 * and emoji codes stay raw: the model passes them back to tools.
 */
export const SLACK_USER_PROFILE_SOURCE = 'slack:user-profile';

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
 * Rewrite mentions of the connector's own bot user (`<@BOT>` or
 * `<@BOT|label>`) as plain `@name` text. Applied to every text sent with the
 * PERSON's token: a host that listens for the person's messages mentioning
 * its bot (a search like `<@BOT> from:<@ME>`) would otherwise be retriggered
 * by its own replies. Bot-token posts need no rewrite, since that search
 * only matches the person's own messages. Other users' mentions are kept.
 */
export function plainTextOwnBotMentions(
  text: string,
  botUserId: string | undefined,
  botName: string | undefined,
): string {
  if (!botUserId) return text;
  const id = botUserId.replace(/[^A-Za-z0-9]/g, '');
  if (!id) return text;
  // The label inside the markup is never used: it is caller text and could
  // carry mention markup of its own. The stored name loses any angle brackets.
  const name = (botName ?? '').replace(/[<>]/g, '') || 'app';
  // Every `<@ID` is rewritten, closed or not, so no bot markup can survive
  // (`<@ID|<@ID>>` included). The label stops at the next `<` or `>`, which
  // keeps the match linear on long runs of unclosed `<@ID|`.
  return text.replace(
    new RegExp(`<@${id}(?![A-Za-z0-9])(?:\\|[^<>]*>|>)?`, 'g'),
    () => `@${name}`,
  );
}

/** {@link plainTextOwnBotMentions} with the bot identity from the workspace record. */
export async function withOwnBotMentionsAsPlainText(text: string): Promise<string>;
export async function withOwnBotMentionsAsPlainText(text: string | undefined): Promise<string | undefined>;
export async function withOwnBotMentionsAsPlainText(text: string | undefined): Promise<string | undefined> {
  if (!text) return text;
  const identity = await getTokenProvider()?.getBotIdentity();
  return plainTextOwnBotMentions(text, identity?.botUserId, identity?.botUsername);
}

/**
 * Resolve user IDs into the in-memory cache. Uses parallel `users.info`
 * calls (faster than `users.list` on large workspaces). Failures are
 * non-fatal — unresolved users simply don't get enriched.
 */
export async function resolveUserIdsToCache(userIds: string[]): Promise<void> {
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
    try {
      const resolved = await runSlackRead(async (client) => {
        const users = new Map<string, CachedUser>();
        const CONCURRENCY = 5;
        for (let i = 0; i < unknownIds.length; i += CONCURRENCY) {
          const batch = unknownIds.slice(i, i + CONCURRENCY);
          const outcomes = await Promise.allSettled(
            batch.map(id => client.users.info({ user: id })),
          );
          for (const [index, outcome] of outcomes.entries()) {
            const id = batch[index];
            if (outcome.status === 'rejected') {
              const error: unknown = outcome.reason;
              if (isTokenExpiredError(error) || isMissingScopeError(error)) throw error;
              const message = error instanceof Error ? error.message : String(error);
              console.warn(
                { error: sanitizeErrorMessage(message) },
                '[slack-mcp] User name enrichment unavailable.',
              );
              continue;
            }
            const result = outcome.value;
            if (result.ok && result.user) {
              const u = result.user;
              users.set(id, {
                name: u.name || id,
                displayName: u.profile?.display_name || u.real_name || u.name || id,
              });
            }
          }
        }
        return users;
      });
      for (const [id, user] of resolved ?? []) userCache.set(id, user);
    } catch (error) {
      if (error instanceof ConnectorError && !AUTH_REQUIRED_CODES.includes(error.code)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        { error: sanitizeErrorMessage(message) },
        '[slack-mcp] User name enrichment unavailable.',
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

/**
 * Add `user_name` / `user_display_name` fields when known. The display name is
 * authored by the Slack user, so it is enveloped here (AGENTS.md invariant #6);
 * the cache stays raw. `user_name` is the handle and stays raw so it can be
 * passed back to tools.
 */
export function enrichMessageWithUserInfo<T extends { user?: string }>(
  msg: T,
): T & { user_name?: string; user_display_name?: string } {
  const cached = msg.user ? userCache.get(msg.user.toUpperCase()) : undefined;
  return {
    ...msg,
    ...(cached
      ? {
          user_name: cached.name,
          user_display_name: wrapUntrusted(cached.displayName, SLACK_USER_PROFILE_SOURCE),
        }
      : {}),
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
    const matchList = matches
      .map((m) => {
        const label = m.matchType === 'username' ? m.name : wrapUntrusted(m.name, SLACK_USER_PROFILE_SOURCE);
        return `${label} (${m.matchType})`;
      })
      .join(', ');
    throw new ConnectorError(
      `Ambiguous user: "${input}" matches multiple users: ${matchList}.`,
      'AMBIGUOUS_USER',
      `Use the user ID directly, or lookup_user_by_email for unambiguous resolution.`,
    );
  }
  return matches[0].id;
}

const PERSON_ID_PATTERN = /^[UW][A-Z0-9]+$/;
const PERSON_MENTION_PATTERN = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** True for a target that names a person: a U…/W… user ID, `<@U…>`, or an email. */
export function isPersonTarget(target: string): boolean {
  const t = target.trim();
  return PERSON_ID_PATTERN.test(t) || PERSON_MENTION_PATTERN.test(t) || EMAIL_PATTERN.test(t);
}

/** Tool-description text shared by every tool that sends through resolveSendTarget. */
export const DM_SAFETY_GUIDANCE = `DIRECT MESSAGES: name the person, not the DM. Pass their Slack user ID (U…) or
email as channel; their DM is opened with the account that sends, so it cannot
reach anyone else. Find a user ID with lookup_user_by_email. A DM channel ID
(D…) on its own is refused, because it does not say who it is for; if you only
have one, add intended_recipient and it is used only if it is that person's DM.`;

export const SEND_TARGET_DESCRIPTION =
  'Where to send — channel ID (e.g., C1234567890), #channel-name (e.g., #general), or for a direct message the person\'s user ID (U…) or email';

export const INTENDED_RECIPIENT_SCHEMA = z
  .string()
  .optional()
  .describe(
    'Only with a DM channel ID (D…): the person (user ID or email) it should belong to. If it is not their DM, nothing is sent.',
  );

/** Where a send goes, or a ready-to-return refusal saying why nothing was sent. */
type SendRefusal = { ok: false; refusal: string };
export type SendTargetResolution = { ok: true; channelId: string; person?: DmRecipient } | SendRefusal;

function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } })?.data?.error;
}

function personNotFoundRefusal(): SendRefusal {
  return {
    ok: false,
    refusal: errorJson({
      error: 'Nothing was sent — no Slack user matches that person.',
      action_required:
        'Use lookup_user_by_email (exact match) or list_slack_users to find the person, then pass their user ID or email.',
      next_step: 'lookup_user_by_email',
    }),
  };
}

function recipientMismatchRefusal(channel: string): SendRefusal {
  // Deliberately does not say who the DM belongs to: that would disclose a
  // person the caller did not name.
  return {
    ok: false,
    refusal: errorJson({
      error: 'RECIPIENT MISMATCH — nothing was sent.',
      action_required:
        'That DM does not belong to the person in intended_recipient. Pass the person\'s user ID or email as the channel instead of a DM channel ID.',
      next_step: 'lookup_user_by_email',
      channel,
    }),
  };
}

/** Look up who a person target (user ID, mention or email) is. */
async function lookupPerson(
  client: WebClient,
  input: string,
): Promise<{ ok: true; person: DmRecipient } | SendRefusal> {
  const t = input.trim();
  const mention = t.match(PERSON_MENTION_PATTERN);
  const requestedId = mention ? mention[1] : PERSON_ID_PATTERN.test(t) ? t : undefined;
  if (!requestedId && !EMAIL_PATTERN.test(t)) return personNotFoundRefusal();
  try {
    const result = requestedId
      ? await client.users.info({ user: requestedId })
      : await client.users.lookupByEmail({ email: t });
    const u = result.user;
    const userId = requestedId ?? u?.id;
    if (!u || !userId) return personNotFoundRefusal();
    return {
      ok: true,
      person: {
        user_id: userId,
        real_name: u.real_name || u.name || userId,
        display_name: u.profile?.display_name || u.real_name || u.name || userId,
        email: u.profile?.email,
      },
    };
  } catch (error) {
    const code = slackErrorCode(error);
    if (code === 'user_not_found' || code === 'users_not_found') {
      return personNotFoundRefusal();
    }
    throw error;
  }
}

async function openDmChannel(client: WebClient, userId: string): Promise<string> {
  const result = await client.conversations.open({ users: userId });
  const channelId = result.channel?.id;
  if (!channelId) {
    throw new ConnectorError(
      'Slack did not return a direct message channel for that person.',
      'DM_OPEN_FAILED',
      'Try again, or check the person is still active in this Slack workspace.',
    );
  }
  return channelId;
}

/**
 * The one place a send target becomes a Slack channel. A direct message is
 * only ever sent to a person the caller named: their DM is opened with the
 * same client that will send, so the channel cannot belong to anyone else.
 *
 *   - Person (user ID, `<@U…>` or email): open their DM.
 *   - DM channel ID with intended_recipient: accepted only if opening the named
 *     person's DM returns that same channel.
 *   - DM channel ID alone: refused; who is in it is never derived.
 *   - Anything else (C…, G…, #name): resolved as a channel, as before.
 */
export async function resolveSendTarget(
  client: WebClient,
  target: string,
  intendedRecipient?: string,
): Promise<SendTargetResolution> {
  const t = target.trim();
  const intended = intendedRecipient?.trim() || undefined;

  if (isPersonTarget(t)) {
    const found = await lookupPerson(client, t);
    if (!found.ok) return found;
    if (intended) {
      const named = await lookupPerson(client, intended);
      if (!named.ok) return named;
      if (named.person.user_id.toUpperCase() !== found.person.user_id.toUpperCase()) {
        return recipientMismatchRefusal(t);
      }
    }
    return { ok: true, channelId: await openDmChannel(client, found.person.user_id), person: found.person };
  }

  const channelId = await resolveChannelId(t);
  if (!channelId.startsWith('D')) return { ok: true, channelId };

  if (!intended) {
    return {
      ok: false,
      refusal: errorJson({
        error: 'DM NOT sent — a direct message must name the person it is for.',
        action_required:
          'Pass the person\'s Slack user ID or email as the channel (their DM is opened for you), or keep the DM channel and add intended_recipient. Find a user ID with lookup_user_by_email.',
        next_step: 'lookup_user_by_email',
        channel: channelId,
      }),
    };
  }
  const named = await lookupPerson(client, intended);
  if (!named.ok) return named;
  const theirDm = await openDmChannel(client, named.person.user_id);
  if (theirDm.toUpperCase() !== channelId.toUpperCase()) return recipientMismatchRefusal(channelId);
  return { ok: true, channelId, person: named.person };
}
