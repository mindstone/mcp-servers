import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callGraph } from './client.js';
import { successJson, withErrorHandling } from './utils.js';
import {
  getChat,
  getPresence,
  listChannels,
  listChats,
  listChatMessages,
  listTeams,
  sendChatMessage,
} from './teams.js';

const READ_ANNOTATIONS = {
  readOnlyHint: true,
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

  server.registerTool(
    'send_chat_message',
    {
      description: 'Send a message to a chat.',
      inputSchema: z.object({
        chatId: z.string().describe('Chat ID'),
        content: z.string().describe('Message content (HTML supported)'),
      }).shape,
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
