import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { epochMsField } from './calls.js';
import { listAgentsByChannel } from './agents.js';
import { sanitizeChat, sanitizeList } from '../sanitize.js';

export function registerChatTools(server: McpServer): void {
  server.registerTool(
    'list_chat_agents',
    {
      description: `List configured chat agents in your Retell account (paginated).

WHEN TO USE:
- Discover chat agents before reading their chats
- Find chat agent IDs by name

NOTE: Returns summary records (agent_id, agent_name, channel, tags, timestamps). Results are filtered to chat agents; use list_agents for voice agents.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key

RELATED TOOLS:
- list_agents: List voice agents instead
- list_chats/get_chat: Read chat transcripts for a returned agent_id

RETURNS: agents, count, pagination_key, has_more. Each agent summary includes agent_id, agent_name, channel, tags, and user_modified_timestamp.`,
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Max results (1-1000). Default: 50.'),
        sort_order: z.enum(['ascending', 'descending']).optional().describe('Sort by last-modified time. Default: descending (most recently modified first).'),
        pagination_key: z.string().optional().describe('Pagination key from previous response for the next page.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const response = await listAgentsByChannel('chat', args, 'retell:list_chat_agents');
      return JSON.stringify(response);
    }),
  );

  server.registerTool(
    'list_chats',
    {
      description: `List chat sessions with filtering and pagination. Returns recent chats by default (newest first).

WHEN TO USE:
- Browse chat history for a chat agent
- Find a chat_id before reading its full transcript with get_chat
- Review chat volume over a time range

FILTERING:
- agent_id accepts an array of one or more agent IDs
- filter_criteria timestamps accept Unix milliseconds (number) or a parseable date string (e.g. "2026-01-01"); date strings are converted to milliseconds before the API call
- Example: { "limit": 20, "agent_id": ["agent_xxx"], "filter_criteria": { "after_start_timestamp": 1735689600000 } }

COMMON MISTAKES:
- Passing one agent_id as a string instead of an array
- Using seconds for numeric timestamps; Retell expects milliseconds

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 422: invalid filter shape → check agent_id is an array and numeric timestamps are milliseconds

RELATED TOOLS:
- get_chat: Get the full transcript and analysis for a returned chat_id
- list_chat_agents: Find chat agent IDs for filtering
- list_calls: Voice-call equivalent of this tool

RETURNS: chats, count, pagination_key, has_more. Each chat includes chat_id, chat_status, agent_id, timestamps, and metadata.`,
      inputSchema: {
        agent_id: z.array(z.string()).optional().describe('Filter chats by one or more agent IDs. Must be an array, even for one agent: ["agent_xxx"].'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max results (1-1000). Default: 50.'),
        sort_order: z.enum(['ascending', 'descending']).optional().describe('Sort by start time. Default: descending (newest first).'),
        pagination_key: z.string().optional().describe('Pagination key from previous response for the next page.'),
        filter_criteria: z.object({
          after_start_timestamp: epochMsField().optional().describe('Only chats started after this time. Unix timestamp in milliseconds (number, e.g. 1735689600000) or a parseable date string (e.g. "2026-01-01").'),
          before_start_timestamp: epochMsField().optional().describe('Only chats started before this time. Unix timestamp in milliseconds (number, e.g. 1738368000000) or a parseable date string (e.g. "2026-02-01").'),
        }).optional().describe('Time-based filters for narrowing chat results.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const body: Record<string, unknown> = {};
      const filterCriteria: Record<string, unknown> = {};

      if (args.agent_id) filterCriteria.agent = args.agent_id.map((id) => ({ agent_id: id }));
      const after = args.filter_criteria?.after_start_timestamp;
      const before = args.filter_criteria?.before_start_timestamp;
      // v3 chat filters use typed operator objects: number filters are
      // {type:'number', op:'ge'|'le', value}; a two-sided window is the
      // range filter {type:'range', op:'bt', value:[lower, upper]}.
      if (after !== undefined && before !== undefined) {
        filterCriteria.start_timestamp = { type: 'range', op: 'bt', value: [after, before] };
      } else if (after !== undefined) {
        filterCriteria.start_timestamp = { type: 'number', op: 'ge', value: after };
      } else if (before !== undefined) {
        filterCriteria.start_timestamp = { type: 'number', op: 'le', value: before };
      }

      if (Object.keys(filterCriteria).length > 0) body.filter_criteria = filterCriteria;
      if (args.limit) body.limit = args.limit;
      if (args.sort_order) body.sort_order = args.sort_order;
      if (args.pagination_key) body.pagination_key = args.pagination_key;

      const result = await retellFetch<unknown>(
        '/v3/list-chats',
        { method: 'POST', body: JSON.stringify(body) },
      );

      const resultObj = (result && typeof result === 'object' && !Array.isArray(result))
        ? result as Record<string, unknown>
        : null;
      const items = resultObj && Array.isArray(resultObj.items)
        ? (resultObj.items as unknown[])
        : (Array.isArray(result) ? result as unknown[] : []);

      return JSON.stringify({
        ok: true,
        chats: sanitizeList(items, sanitizeChat, 'retell:list_chats'),
        count: items.length,
        pagination_key: resultObj?.pagination_key,
        has_more: resultObj?.has_more,
        message: `Found ${items.length} chat(s).`,
      });
    }),
  );

  server.registerTool(
    'get_chat',
    {
      description: `Get details of a specific chat including full transcript, per-message breakdown, and analysis.

WHEN TO USE:
- After list_chats, to read one chat's full transcript
- To review chat analysis (summary, sentiment, success) for quality checks

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: chat_id not found → check the ID returned by list_chats

RELATED TOOLS:
- list_chats: Find chat IDs
- get_call: Voice-call equivalent (transcript, recording, analysis)

RETURNS: chat_id, chat_status, agent_id, transcript, message_with_tool_calls, chat_analysis, start/end timestamps, metadata.`,
      inputSchema: {
        chat_id: z.string().describe('The chat ID returned by list_chats.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await retellFetch<Record<string, unknown>>(
        `/get-chat/${encodeURIComponent(args.chat_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeChat(result, 'retell:get_chat') as Record<string, unknown>),
      });
    }),
  );
}
