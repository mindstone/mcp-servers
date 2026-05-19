import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callGraph } from './client.js';
import { successJson, withErrorHandling } from './utils.js';
import {
  getMessage,
  listChats,
  listMessages,
  listTeamChannels,
  replyMessage,
  searchMessages,
  sendMessage,
} from './teams.js';

const OptionalId = z.string().optional();
const MessageScopeSchema = {
  chatId: OptionalId.describe('Teams chat ID'),
  chat_id: OptionalId.describe('Alias for chatId'),
  teamId: OptionalId.describe('Team ID for channel message operations'),
  team_id: OptionalId.describe('Alias for teamId'),
  channelId: OptionalId.describe('Channel ID for channel message operations'),
  channel_id: OptionalId.describe('Alias for channelId'),
};

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

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
    'list_messages',
    {
      description:
        'List recent Teams messages from a chat, or from a team channel when teamId and channelId are provided.',
      inputSchema: z.object({
        ...MessageScopeSchema,
        top: z.number().optional().describe('Max messages to return (default: 50, max: 50)'),
      }).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => listMessages(c, args, signal))),
    ),
  );

  server.registerTool(
    'search_messages',
    {
      description: 'Search Teams messages using Microsoft Search.',
      inputSchema: z.object({
        query: z.string().optional().describe('Search query'),
        top: z.number().optional().describe('Max search results (default: 25, max: 50)'),
      }).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => searchMessages(c, args, signal))),
    ),
  );

  server.registerTool(
    'get_message',
    {
      description: 'Get a specific Teams chat or channel message by ID.',
      inputSchema: z.object({
        ...MessageScopeSchema,
        messageId: OptionalId.describe('Teams message ID'),
        message_id: OptionalId.describe('Alias for messageId'),
        id: OptionalId.describe('Alias for messageId'),
      }).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => getMessage(c, args, signal))),
    ),
  );

  server.registerTool(
    'list_team_channels',
    {
      description:
        'List channels for a team. If teamId is omitted, lists joined teams with their channels.',
      inputSchema: z.object({
        teamId: OptionalId.describe('Team ID. Omit to list joined teams with channels.'),
        team_id: OptionalId.describe('Alias for teamId'),
      }).shape,
      annotations: READ_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => listTeamChannels(c, args, signal))),
    ),
  );

  server.registerTool(
    'send_message',
    {
      description: 'Send a Teams message to a chat or team channel.',
      inputSchema: z.object({
        ...MessageScopeSchema,
        content: z.string().optional().describe('Message content (HTML supported)'),
      }).shape,
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => sendMessage(c, args, signal))),
    ),
  );

  server.registerTool(
    'reply_message',
    {
      description: 'Reply to a Teams chat or channel message.',
      inputSchema: z.object({
        ...MessageScopeSchema,
        messageId: OptionalId.describe('Teams message ID to reply to'),
        message_id: OptionalId.describe('Alias for messageId'),
        id: OptionalId.describe('Alias for messageId'),
        content: z.string().optional().describe('Reply content (HTML supported)'),
      }).shape,
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(async (args, extra) =>
      successJson(await callGraph(extra, (c, signal) => replyMessage(c, args, signal))),
    ),
  );
}
