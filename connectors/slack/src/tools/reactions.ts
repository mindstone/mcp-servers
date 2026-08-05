import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson, withErrorHandling } from '../utils.js';
import { getSlackUserClient } from '../client.js';
import { resolveChannelId } from '../helpers.js';
import { wrapUntrusted } from '../untrusted-content.js';

/**
 * Slack constrains custom emoji names to lowercase alphanumerics plus
 * `_`, `+`, `-`, and emoji.list values to either an `alias:<name>` pointer or
 * an HTTPS image URL on Slack-owned infrastructure (slack-edge.com CDN or
 * slack.com). That constraint is ENFORCED here, not assumed: any entry that
 * violates it is attacker-shaped (a compromised or unexpected upstream could
 * otherwise smuggle arbitrary model-visible strings through this tool) and is
 * dropped, observably, rather than forwarded.
 *
 * Validation alone is not sufficient — a value like
 * `https://ignore-previous-instructions@slack.com/` passes a protocol+hostname
 * check while carrying attacker text in the userinfo, query, or fragment. So
 * every forwarded name and value is ADDITIONALLY wrapped in an
 * `<untrusted-content>` envelope (invariant #6): even a hostile entry that
 * passes validation reaches the model strictly as data.
 */
const SLACK_EMOJI_NAME_PATTERN = /^[a-z0-9_+-]+$/;
const SLACK_EMOJI_ALIAS_PATTERN = /^alias:[a-z0-9_+-]+$/;
const SLACK_EMOJI_HOSTNAME = /(^|\.)(slack\.com|slack-edge\.com)$/;
const SLACK_EMOJI_SOURCE = 'slack:emoji-list';

function isSlackEmojiName(name: string): boolean {
  return SLACK_EMOJI_NAME_PATTERN.test(name);
}

function isSlackEmojiValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (SLACK_EMOJI_ALIAS_PATTERN.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SLACK_EMOJI_HOSTNAME.test(url.hostname);
  } catch {
    return false;
  }
}

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

Returns a name → image-URL (or alias) map with names and values wrapped in
<untrusted-content> envelopes (third-party-authored content). Use the names
with add_slack_reaction / remove_slack_reaction — Slack's built-in emoji
always work without being listed here.`,
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
      // Validate every entry against Slack's own emoji constraints before
      // forwarding (see the module-top comment): names must be Slack emoji
      // names, values must be alias pointers or Slack-hosted HTTPS URLs.
      // Non-conforming entries are dropped AND reported, never silently
      // forwarded or silently swallowed. Conforming entries are still
      // third-party-authored strings, so both name and value are enveloped
      // before they reach the model.
      const validEntries: Array<[string, string]> = [];
      let dropped = 0;
      for (const [name, value] of Object.entries(emoji)) {
        if (isSlackEmojiName(name) && isSlackEmojiValue(value)) {
          validEntries.push([
            wrapUntrusted(name, SLACK_EMOJI_SOURCE)!,
            wrapUntrusted(value, SLACK_EMOJI_SOURCE)!,
          ]);
        } else {
          dropped += 1;
        }
      }
      if (dropped > 0) {
        console.error(
          `[slack-mcp] emoji.list returned ${dropped} entr${dropped === 1 ? 'y' : 'ies'} that ` +
            'violate Slack emoji name/value constraints; dropped from the response. ' +
            'This indicates an unexpected or compromised upstream response.',
        );
      }
      const entries = validEntries.sort(([a], [b]) => a.localeCompare(b));
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
        ...(dropped > 0
          ? {
              omitted_invalid_entries: dropped,
              validation_note: `${dropped} emoji entr${dropped === 1 ? 'y' : 'ies'} omitted: the response contained names or values outside Slack's emoji constraints (unexpected upstream content, not forwarded to the model).`,
            }
          : {}),
      });
    }),
  );
}
