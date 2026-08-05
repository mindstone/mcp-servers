import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { hasScope } from '@mindstone/mcp-server-microsoft-shared';
import { z } from 'zod';
import { callGraph, getTokenProvider } from './client.js';
import { errorResponse, successJson, withErrorHandling } from './utils.js';
import { AUTH_TOOL_NAME } from './types.js';
import {
  getChat,
  getPresence,
  listChannelMessages,
  listChannels,
  listChats,
  listChatMessages,
  listTeams,
  replyToChannelMessage,
  sendChannelMessage,
  sendChatMessage,
} from './teams.js';

/**
 * `ui://` resource URI the compose_chat_message iframe is served under. The
 * shared compose-app template posts `send_chat_message` when the user clicks
 * Send; the HTML twin lives in src/resources/compose-message-template.ts
 * (generated from the shared compose-app package, drift-gated).
 */
export const COMPOSE_MESSAGE_RESOURCE_URI = 'ui://microsoft-teams/compose-message';

const ANSI_ESCAPE_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const HTML_TAG_PATTERN = /<[^>]*>/g;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sanitizeViewSummaryPart(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '').replace(HTML_TAG_PATTERN, '').trim();
}

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
};

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/**
 * Some Teams Graph surfaces (channel messages, user lookup, other users'
 * presence) need delegated permissions beyond the cohort's base scope set,
 * and several are admin-consent-gated under Microsoft's managed consent
 * policy. When the connected account's token lacks the scope, return an
 * actionable error up front instead of letting Graph 403 — same pattern as
 * the SharePoint connector's Sites.Read.All gate. When the scope cannot be
 * introspected (no token on disk yet), fall through to the real call so the
 * standard auth_required envelope handles it.
 */
async function requireScopesGranted(
  requiredScopes: string[],
  feature: string,
): Promise<CallToolResult | null> {
  let tokenScope: string | undefined;
  try {
    const tokenData = await getTokenProvider().loadToken();
    if (!tokenData) return null;
    tokenScope = tokenData.scope;
  } catch {
    return null;
  }
  const missing = requiredScopes.filter((scope) => !hasScope(tokenScope, scope));
  if (missing.length === 0) return null;
  return errorResponse({
    error: `${feature} requires Microsoft Graph permission(s) not granted to the connected account: ${missing.join(', ')}.`,
    action_required:
      'Reconnect the Microsoft account with the additional permissions. In many organizations an administrator must approve these permissions first.',
    next_step: AUTH_TOOL_NAME,
    missing_scopes: missing,
  });
}

export function registerTeamsTools(server: McpServer): void {
  server.registerTool(
    'list_chats',
    {
      description: 'List recent Teams chats (1:1, group, and meeting chats).',
      inputSchema: z.object({
        top: z.number().optional().describe('Max chats to return (default: 25, max: 50)'),
      }).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => listChats(c, args, signal))),
    ),
  );

  server.registerTool(
    'get_chat',
    {
      description: 'Get details about a specific chat.',
      inputSchema: z.object({
        chatId: z.string().describe('Chat ID'),
      }).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => getChat(c, args, signal))),
    ),
  );

  server.registerTool(
    'list_chat_messages',
    {
      description: 'Get recent messages from a chat.',
      inputSchema: z.object({
        chatId: z.string().describe('Chat ID'),
        top: z.number().optional().describe('Max messages to return (default: 50, max: 50)'),
      }).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => listChatMessages(c, args, signal))),
    ),
  );

  // ---------------------------------------------------------------------
  // compose_chat_message
  // ---------------------------------------------------------------------
  // Returns an editable draft the host renders as an interactive compose view
  // (the compose-message iframe). Performs no Graph send itself — the iframe
  // invokes send_chat_message when the user clicks Send. Registered WITHOUT
  // withErrorHandling: it does no send I/O, and its InvalidParams validation
  // must surface as-is rather than as an auth-flavoured retry envelope. Teams
  // routes purely by chatId, so there is no recipient resolution (unlike Slack
  // DMs) — the draft carries the target chat + text verbatim.
  server.registerTool(
    'compose_chat_message',
    {
      description: `Open an inline editable message compose form before sending to a Teams chat. Use this when the user wants to write or send a Teams message so they can review and edit it first. Does NOT send directly — the form posts the message (via send_chat_message) when the user clicks Send.

PARAMETERS: target (the chat ID to send to), text (message content).`,
      inputSchema: z
        .object({
          target: z.string().min(1).describe('The chat ID to send the message to'),
          text: z.string().min(1).describe('Message content (HTML supported)'),
        })
        .strict(),
      annotations: WRITE_ANNOTATIONS,
    },
    async (args): Promise<CallToolResult> => {
      const target = typeof args.target === 'string' ? args.target.trim() : '';
      const text = typeof args.text === 'string' ? args.text : '';
      if (target.length === 0 || text.trim().length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'compose_chat_message requires a non-empty "target" (chat ID) and "text". Provide both so the editable draft has content for the user to review.',
        );
      }

      const structuredContent = { target, text };

      const viewSummaryTarget = truncateText(sanitizeViewSummaryPart(target), 120);
      const viewSummary = truncateText(
        `Teams message draft to ${viewSummaryTarget || '(no target)'}.`,
        280,
      );
      const fallbackTarget = truncateText(target, 256);
      const fallbackText = truncateText(text, 5_000);

      return {
        content: [
          {
            type: 'text',
            text: `Drafting a Teams message to ${target}\n\n${JSON.stringify(structuredContent)}\n\n[View: ${COMPOSE_MESSAGE_RESOURCE_URI}]`,
          },
        ],
        _meta: {
          ui: {
            resourceUri: COMPOSE_MESSAGE_RESOURCE_URI,
            presentation: 'primary',
            viewSummary,
            viewRoleLabel: 'Teams message',
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

  server.registerTool(
    'send_chat_message',
    {
      description: 'Send a message to a chat.',
      inputSchema: z.object({
        chatId: z.string().describe('Chat ID'),
        content: z.string().describe('Message content (HTML supported)'),
      }).strict(),
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => sendChatMessage(c, args, signal))),
    ),
  );

  server.registerTool(
    'list_teams',
    {
      description: 'List Teams you are a member of.',
      inputSchema: z.object({}).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => listTeams(c, args, signal))),
    ),
  );

  server.registerTool(
    'list_channels',
    {
      description: 'List channels in a Team.',
      inputSchema: z.object({
        teamId: z.string().describe('Team ID'),
      }).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => listChannels(c, args, signal))),
    ),
  );

  server.registerTool(
    'list_channel_messages',
    {
      description:
        'List recent messages in a Teams channel. Requires the ChannelMessage.Read.All Graph permission, which may need tenant admin approval.',
      inputSchema: z.object({
        teamId: z.string().describe('Team ID'),
        channelId: z.string().describe('Channel ID'),
        top: z.number().optional().describe('Max messages to return (default: 25, max: 50)'),
      }).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) => {
      const gate = await requireScopesGranted(
        ['ChannelMessage.Read.All'],
        'Reading channel messages',
      );
      if (gate) return gate;
      return successJson(await callGraph(extra, (c, signal) => listChannelMessages(c, args, signal)));
    }),
  );

  server.registerTool(
    'send_channel_message',
    {
      description:
        'Post a new message to a Teams channel. Requires the ChannelMessage.Send Graph permission, which may need tenant admin approval.',
      inputSchema: z
        .object({
          teamId: z.string().describe('Team ID'),
          channelId: z.string().describe('Channel ID'),
          content: z.string().describe('Message content (HTML supported)'),
        })
        .strict(),
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) => {
      const gate = await requireScopesGranted(['ChannelMessage.Send'], 'Posting channel messages');
      if (gate) return gate;
      return successJson(await callGraph(extra, (c, signal) => sendChannelMessage(c, args, signal)));
    }),
  );

  server.registerTool(
    'reply_to_channel_message',
    {
      description:
        'Reply to an existing message in a Teams channel. Requires the ChannelMessage.Send Graph permission, which may need tenant admin approval.',
      inputSchema: z
        .object({
          teamId: z.string().describe('Team ID'),
          channelId: z.string().describe('Channel ID'),
          messageId: z.string().describe('ID of the channel message to reply to'),
          content: z.string().describe('Reply content (HTML supported)'),
        })
        .strict(),
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) => {
      const gate = await requireScopesGranted(['ChannelMessage.Send'], 'Replying to channel messages');
      if (gate) return gate;
      return successJson(await callGraph(extra, (c, signal) => replyToChannelMessage(c, args, signal)));
    }),
  );

  server.registerTool(
    'get_presence',
    {
      description: 'Get your current presence status (available, busy, away, etc.).',
      inputSchema: z.object({}).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => getPresence(c, args, signal))),
    ),
  );
}
