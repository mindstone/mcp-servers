import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson, withErrorHandling } from '../utils.js';
import { getSlackClient, getSlackUserClient } from '../client.js';
import { resolveUserId } from '../helpers.js';
import { notConnectedJson } from './auth.js';

const RESPONSE_FORMAT_ENUM = z.enum(['concise', 'detailed']).optional();

export function registerUserTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // list_slack_users
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_slack_users',
    {
      description: `List active (non-bot, non-deleted) users in the Slack workspace.

When name filter is provided, auto-paginates across up to 5 pages to find
matches. For exact email match, prefer lookup_user_by_email.`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(1000).optional(),
        cursor: z.string().optional(),
        name: z
          .string()
          .optional()
          .describe(
            'Filter users by name (case-insensitive partial match). Auto-paginates up to 5 pages to find matches. For exact email match, use lookup_user_by_email instead.',
          ),
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
      const client = await getSlackClient();
      if (!client) return notConnectedJson();
      const isConcise = args.response_format === 'concise';
      const nameFilter = args.name?.toLowerCase();
      const requestedLimit = args.limit || 100;
      const manualCursor = args.cursor;

      if (nameFilter && !manualCursor) {
        const MAX_PAGES = 5;
        type UserEntry = {
          id?: string;
          name?: string;
          display_name?: string;
          real_name?: string;
          email?: string;
          is_admin?: boolean;
        };
        const allMatches: UserEntry[] = [];
        let pagesSearched = 0;
        let usersCursor: string | undefined;
        do {
          const page = await client.users.list({ limit: 200, cursor: usersCursor });
          pagesSearched++;
          const members = page.members?.filter((u) => !u.is_bot && !u.deleted) || [];
          const filtered = members.filter(
            (u) =>
              u.name?.toLowerCase().includes(nameFilter) ||
              u.profile?.display_name?.toLowerCase().includes(nameFilter) ||
              u.real_name?.toLowerCase().includes(nameFilter),
          );
          for (const u of filtered) {
            allMatches.push({
              id: u.id,
              name: u.name,
              display_name: u.profile?.display_name,
              ...(isConcise
                ? {}
                : {
                    real_name: u.real_name,
                    email: u.profile?.email,
                    is_admin: u.is_admin,
                  }),
            });
            if (allMatches.length >= requestedLimit) break;
          }
          if (allMatches.length >= requestedLimit) break;
          usersCursor = page.response_metadata?.next_cursor || undefined;
        } while (usersCursor && pagesSearched < MAX_PAGES);
        return JSON.stringify({
          ok: true,
          users: allMatches,
          pagesSearched,
          ...(allMatches.length === 0
            ? {
                hint: `No users matching "${args.name}" found after searching ${pagesSearched} pages. Try lookup_user_by_email for exact match.`,
              }
            : {}),
        });
      }

      const result = await client.users.list({ limit: requestedLimit, cursor: manualCursor });
      const filteredMembers = result.members?.filter((u) => !u.is_bot && !u.deleted);
      const users = filteredMembers?.map((u) => ({
        id: u.id,
        name: u.name,
        display_name: u.profile?.display_name,
        ...(isConcise
          ? {}
          : {
              real_name: u.real_name,
              email: u.profile?.email,
              is_admin: u.is_admin,
            }),
      }));
      const nextCursor = result.response_metadata?.next_cursor || null;
      const hasMore = !!nextCursor;
      return JSON.stringify({
        ok: true,
        users,
        nextCursor,
        hasMore,
        ...(hasMore ? { hint: 'More results available. Use cursor parameter to fetch next page.' } : {}),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // get_slack_user_profile
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_slack_user_profile',
    {
      description: `Get detailed profile for a specific Slack user.

Get user ID from list_slack_users or from a message, or use @username format.`,
      inputSchema: z.object({
        user: z.string().min(1).describe('User ID (e.g., U1234567890) or @username (e.g., @john)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const client = await getSlackClient();
      if (!client) return notConnectedJson();
      const userId = await resolveUserId(client, args.user);
      const result = await client.users.info({ user: userId });
      const user = result.user;
      return JSON.stringify({
        ok: true,
        user: {
          id: user?.id,
          name: user?.name,
          real_name: user?.real_name,
          display_name: user?.profile?.display_name,
          email: user?.profile?.email,
          title: user?.profile?.title,
          phone: user?.profile?.phone,
          is_admin: user?.is_admin,
          is_owner: user?.is_owner,
          tz: user?.tz,
          status_text: user?.profile?.status_text,
          status_emoji: user?.profile?.status_emoji,
        },
      });
    }),
  );

  // ---------------------------------------------------------------------
  // lookup_user_by_email
  // ---------------------------------------------------------------------
  server.registerTool(
    'lookup_user_by_email',
    {
      description: `Find a Slack user by their email address. PREFERRED method for resolving users — exact match, no ambiguity.

WHEN TO USE: Always use this tool (instead of list_slack_users name search)
when you have the user's email. It returns an exact match.

WORKFLOW for sending DMs:
  1. lookup_user_by_email({ email: "alice@company.com" }) → get user.id
  2. open_slack_dm({ user: "<user_id>" }) → get DM channel
  3. post_slack_message({ channel: "<dm_channel>", text: "...", intended_recipient: "<user_id>" })

Requires users:read.email scope (may need admin approval).`,
      inputSchema: z.object({
        email: z.string().email().describe('Email address to look up'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const client = (await getSlackUserClient()) ?? (await getSlackClient());
      if (!client) return notConnectedJson();
      try {
        const result = await client.users.lookupByEmail({ email: args.email });
        const user = result.user;
        return JSON.stringify({
          ok: true,
          user: {
            id: user?.id,
            name: user?.name,
            real_name: user?.real_name,
            display_name: user?.profile?.display_name,
            email: user?.profile?.email,
            is_admin: user?.is_admin,
            deleted: user?.deleted,
          },
        });
      } catch (error) {
        const errCode = (error as { data?: { error?: string } }).data?.error;
        if (errCode === 'users_not_found') {
          return errorJson({
            error: 'User not found for this email',
            action_required:
              'The email may not be registered or the user may be deactivated. Try list_slack_users with name filter.',
            next_step: 'list_slack_users',
            email: args.email,
          });
        }
        throw error;
      }
    }),
  );

  // ---------------------------------------------------------------------
  // open_slack_dm
  // ---------------------------------------------------------------------
  server.registerTool(
    'open_slack_dm',
    {
      description: `Open or get the DM channel with a user by their Slack User ID.

REQUIRES a Slack User ID (U... or W...) — does NOT accept names or usernames.
Use lookup_user_by_email (preferred, exact match) or list_slack_users to get
the User ID first.

Returns the DM channel ID (D...) plus verified recipient identity for use with
post_slack_message. Does NOT send a notification.

WORKFLOW:
  1. lookup_user_by_email({ email: "alice@company.com" }) → get user.id
  2. open_slack_dm({ user: "U1234567890" }) → get DM channel + verified recipient
  3. post_slack_message({ channel: "D...", text: "...", intended_recipient: "U1234567890" })`,
      inputSchema: z.object({
        user: z
          .string()
          .min(1)
          .describe(
            'Slack User ID (e.g., U1234567890 or W1234567890). Use lookup_user_by_email or list_slack_users to find the ID first.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        // Can create a brand-new DM channel that becomes visible to both
        // participants in their Slack client. Idempotent because Slack
        // returns the existing channel on subsequent calls.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const botClient = await getSlackClient();
      if (!botClient) return notConnectedJson();
      const userClient = await getSlackUserClient();
      if (!userClient) {
        return errorJson({
          error: 'Opening DMs requires user authorization.',
          action_required:
            'Reconnect Slack via authenticate_slack_workspace to grant im:write.',
          next_step: 'authenticate_slack_workspace',
        });
      }
      const userInput = args.user;
      let userId: string;
      const dmMentionMatch = userInput.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/);
      if (dmMentionMatch) {
        userId = dmMentionMatch[1];
      } else if (/^[UW][A-Z0-9]+$/i.test(userInput)) {
        userId = userInput.toUpperCase();
      } else {
        return errorJson({
          error: `open_slack_dm requires a Slack User ID (e.g., U1234567890), not a name or username.`,
          action_required:
            'Use lookup_user_by_email (preferred for accuracy) or list_slack_users to find the user ID first.',
          next_step: 'lookup_user_by_email',
          received: userInput,
          example_workflow: [
            '1. lookup_user_by_email({ email: "alice@company.com" }) → get user.id',
            '2. open_slack_dm({ user: "<user_id>" }) → get DM channel',
            '3. post_slack_message({ channel: "<dm_channel>", text: "...", intended_recipient: "<user_id>" })',
          ],
        });
      }

      const dmOpenResult = await userClient.conversations.open({ users: userId });
      if (!dmOpenResult.ok || !dmOpenResult.channel?.id) {
        return errorJson({
          error: 'Failed to open DM channel',
          action_required: 'Verify the user ID is valid and the user is in your workspace.',
          next_step: 'lookup_user_by_email',
        });
      }
      let dmUserProfile: { real_name?: string; display_name?: string; email?: string } | null = null;
      try {
        const dmUserInfo = await botClient.users.info({ user: userId });
        if (dmUserInfo.ok && dmUserInfo.user) {
          dmUserProfile = {
            real_name: dmUserInfo.user.real_name,
            display_name: dmUserInfo.user.profile?.display_name,
            email: dmUserInfo.user.profile?.email,
          };
        }
      } catch {
        // best-effort
      }
      const alreadyOpen = dmOpenResult.already_open === true;
      const recipientLabel = dmUserProfile?.display_name || dmUserProfile?.real_name || userId;
      return JSON.stringify({
        ok: true,
        channel: dmOpenResult.channel.id,
        channelId: dmOpenResult.channel.id,
        userId,
        ...(dmUserProfile
          ? {
              recipient: {
                user_id: userId,
                real_name: dmUserProfile.real_name,
                display_name: dmUserProfile.display_name,
                ...(dmUserProfile.email ? { email: dmUserProfile.email } : {}),
              },
            }
          : {}),
        isNew: !alreadyOpen,
        message: alreadyOpen
          ? `Existing DM channel with ${recipientLabel}: ${dmOpenResult.channel.id}`
          : `Opened new DM channel with ${recipientLabel}: ${dmOpenResult.channel.id}`,
      });
    }),
  );
}
