import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { sanitizeAgentTool, sanitizeList } from '../sanitize.js';
import { ElevenLabsError } from '../types.js';
import { unwrapUntrusted, unwrapUntrustedJsonStrings } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.tools)) return obj.tools;
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
      : undefined;
}

/** Same deep-merge the agent authoring surface uses for advanced_config. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) {
    return patch;
  }

  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

export function registerAgentToolTools(server: McpServer): void {
  server.registerTool(
    'list_agent_tools',
    {
      description: `List workspace tools available to your ElevenLabs agents (webhook, client, and system tools).

WHEN TO USE:
- Discover tool IDs before wiring a tool into an agent's configuration
- Inventory existing webhook/client tools before adding a new one

EXAMPLE: {"page_size": 10}
EXAMPLE: {"search": "calendar"}

RELATED TOOLS:
- add_agent_tool: create a webhook or client tool when none exists yet
- update_agent: attach returned tool IDs through advanced_config

RETURNS: tools, count, next_cursor.

FREE.`,
      inputSchema: z.object({
        search: z.string().min(1).optional()
          .describe('Optional name prefix filter; only tools whose names start with this string are returned.'),
        page_size: z.number().int().min(1).max(100).optional()
          .describe('Maximum number of tools to return (for live checks, use 1).'),
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
      if (args.search) params.set('search', args.search);
      if (args.page_size !== undefined) params.set('page_size', String(args.page_size));
      if (args.cursor) params.set('cursor', args.cursor);
      const qs = params.toString();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        `${ENDPOINTS.TOOLS}${qs ? `?${qs}` : ''}`,
        { method: 'GET' },
      );
      const items = extractItems(result);
      return JSON.stringify({
        ok: true,
        tools: sanitizeList(items, sanitizeAgentTool, 'elevenlabs-agents:list_agent_tools'),
        count: items.length,
        next_cursor: extractNextCursor(result),
        message: `Found ${items.length} workspace tool(s).`,
      });
    }),
  );

  server.registerTool(
    'add_agent_tool',
    {
      description: `Add a webhook or client tool to the workspace so agents can call it during conversations.

WHEN TO USE:
- Wire an external HTTP endpoint (booking, CRM lookup, order status) into agent conversations
- Register a client-side tool the host application implements

EXAMPLE (webhook): {"type": "webhook", "name": "check_order_status", "description": "Look up an order by ID.", "url": "https://example.com/api/order", "method": "POST"}
EXAMPLE (client): {"type": "client", "name": "open_help_center", "description": "Open the help center in the app.", "expects_response": false}

RELATED TOOLS:
- list_agent_tools: check for an existing tool first and get its ID
- update_agent: attach the created tool to an agent via advanced_config

RETURNS: tool (the created tool, including its ID).

COST: FREE for the write itself; the tool runs inside billable conversations once attached to an agent.

COMMON MISTAKES:
- type "webhook" requires url.
- advanced_config deep-merges LAST into the tool config; it overrides first-class fields on conflicting paths.`,
      inputSchema: z.object({
        type: z.enum(['webhook', 'client'])
          .describe('Tool kind: "webhook" calls an HTTP endpoint; "client" is executed by the host application.'),
        name: z.string().min(1)
          .describe('Tool name the agent uses to call it (snake_case recommended).'),
        description: z.string().min(1)
          .describe('When the agent should use this tool and what it does.'),
        url: z.string().url().optional()
          .describe('Webhook endpoint URL. Required when type is "webhook". May include {path_param} placeholders.'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional()
          .describe('HTTP method for webhook tools. Default: ElevenLabs API default (GET).'),
        expects_response: z.boolean().optional()
          .describe('Client tools only: when true, the conversation blocks until the client responds.'),
        advanced_config: z.record(z.unknown()).optional()
          .describe('Optional raw tool_config fragments (request headers, parameter schemas, timeouts). Deep-merged LAST for full-platform reach.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (args.type === 'webhook' && !args.url) {
        throw new ElevenLabsError(
          'Tool type "webhook" requires url.',
          'INVALID_ARGUMENTS',
          'Send the endpoint URL the webhook should call, then retry.',
        );
      }

      // Same round-trip contract as the agent authoring tools: names and
      // descriptions come back enveloped from list_agent_tools, so a copied
      // value must not be stored upstream as an envelope.
      const toolConfig: Obj = {
        type: args.type,
        name: unwrapUntrusted(args.name),
        description: unwrapUntrusted(args.description),
      };
      if (args.type === 'webhook') {
        toolConfig.api_schema = {
          url: args.url,
          ...(args.method !== undefined ? { method: args.method } : {}),
        };
      }
      if (args.type === 'client' && args.expects_response !== undefined) {
        toolConfig.expects_response = args.expects_response;
      }
      const advancedConfig = args.advanced_config
        ? unwrapUntrustedJsonStrings(args.advanced_config)
        : undefined;
      const merged = isObj(advancedConfig)
        ? deepMerge(toolConfig, advancedConfig) as Obj
        : toolConfig;

      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.TOOLS,
        { method: 'POST', body: JSON.stringify({ tool_config: merged }) },
      );
      return JSON.stringify({
        ok: true,
        tool: sanitizeAgentTool(result, 'elevenlabs-agents:add_agent_tool'),
        message: `Added ${args.type} tool ${args.name}.`,
      });
    }),
  );
}
