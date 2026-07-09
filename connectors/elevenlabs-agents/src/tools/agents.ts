import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { sanitizeAgent, sanitizeAgentSummary, sanitizeList } from '../sanitize.js';
import { withErrorHandling } from '../utils.js';

function extractItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.agents)) return obj.agents;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function extractNextCursor(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const obj = result as Record<string, unknown>;
  return typeof obj.next_cursor === 'string'
    ? obj.next_cursor
    : typeof obj.cursor === 'string'
      ? obj.cursor
      : typeof obj.next_page_token === 'string'
        ? obj.next_page_token
        : undefined;
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    'list_agents',
    {
      description: `List voice agents in your ElevenLabs Conversational AI workspace.

WHEN TO USE:
- Discover available agent IDs before inspecting one in detail
- Inventory check before reviewing prompts or recent conversations

EXAMPLE: {"page_size": 10}

RELATED TOOLS:
- get_agent: inspect a returned agent_id in full
- list_conversations: review recent calls for a returned agent_id

RETURNS: agents, count, next_cursor.

FREE.`,
      inputSchema: z.object({
        page_size: z.number().int().min(1).max(100).optional()
          .describe('Maximum number of agents to return (for live checks, use 1).'),
        cursor: z.string().optional().describe('Pagination cursor from the previous response.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const params = new URLSearchParams();
      if (args.page_size !== undefined) params.set('page_size', String(args.page_size));
      if (args.cursor) params.set('cursor', args.cursor);
      const qs = params.toString();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        `${ENDPOINTS.AGENTS}${qs ? `?${qs}` : ''}`,
        { method: 'GET' },
      );
      const items = extractItems(result);
      return JSON.stringify({
        ok: true,
        agents: sanitizeList(items, sanitizeAgentSummary, 'elevenlabs-agents:list_agents'),
        count: items.length,
        next_cursor: extractNextCursor(result),
        message: `Found ${items.length} agent(s).`,
      });
    }),
  );

  server.registerTool(
    'get_agent',
    {
      description: `Get full configuration for one ElevenLabs agent, including prompts and nested conversation settings.

WHEN TO USE:
- Inspect the system prompt or first message before changing anything
- Confirm the exact agent configuration behind recent conversations

EXAMPLE: {"agent_id": "agent_123"}

RELATED TOOLS:
- list_agents: discover valid agent IDs
- list_conversations: inspect recent conversations for this agent

RETURNS: agent.

FREE.`,
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('Agent ID to inspect. Use list_agents if you only know the name.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.agent(args.agent_id),
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        agent: sanitizeAgent(result, 'elevenlabs-agents:get_agent'),
      });
    }),
  );
}
