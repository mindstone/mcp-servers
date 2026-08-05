import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { sanitizeAgentTool, sanitizeList } from '../sanitize.js';
import { ElevenLabsError } from '../types.js';
import { unwrapUntrusted, unwrapUntrustedJsonStrings } from '../untrusted-content.js';
import { validatePublicHttpsUrl } from '../url-safety.js';
import { withErrorHandling } from '../utils.js';

type Obj = Record<string, unknown>;

/**
 * First-class tool-config fields are validated by dedicated tool arguments, so
 * `advanced_config` must not (re)set them — otherwise the raw passthrough
 * becomes a bypass around exactly the validation those arguments carry (the
 * type enum, the webhook URL policy, the method enum). The check is
 * path-aware rather than a recursive key ban: JSON-Schema parameter fragments
 * legitimately contain keys named `type` or `url` deeper down.
 */
const FIRST_CLASS_TOOL_CONFIG_KEYS = new Set(['type', 'name', 'description', 'expects_response']);
const FIRST_CLASS_API_SCHEMA_KEYS = new Set(['url', 'method']);

/**
 * The merged structure is revalidated as a whole before anything is sent
 * upstream, so even a merge bug cannot put an unvalidated `type`, webhook URL,
 * or method on the wire. `passthrough()` keeps the advanced fragments the
 * merge exists for (request headers, parameter schemas, timeouts).
 */
const mergedToolConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('webhook'),
    name: z.string().min(1),
    description: z.string().min(1),
    api_schema: z.object({
      url: z.string().min(1),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    type: z.literal('client'),
    name: z.string().min(1),
    description: z.string().min(1),
    expects_response: z.boolean().optional(),
  }).passthrough(),
]);

function assertNoFirstClassKeysInAdvancedConfig(advancedConfig: Obj, type: 'webhook' | 'client'): void {
  for (const key of Object.keys(advancedConfig)) {
    if (FIRST_CLASS_TOOL_CONFIG_KEYS.has(key)) {
      throw new ElevenLabsError(
        `advanced_config must not set "${key}"; it is a first-class field.`,
        'INVALID_ARGUMENTS',
        `Pass "${key}" as a top-level tool argument instead of inside advanced_config.`,
      );
    }
  }

  const apiSchema = advancedConfig.api_schema;
  if (apiSchema === undefined) return;
  if (type === 'client') {
    throw new ElevenLabsError(
      'advanced_config must not set "api_schema" for a client tool; client tools have no HTTP endpoint.',
      'INVALID_ARGUMENTS',
      'Remove api_schema, or create a webhook tool with a public https url instead.',
    );
  }
  if (isObj(apiSchema)) {
    for (const key of Object.keys(apiSchema)) {
      if (FIRST_CLASS_API_SCHEMA_KEYS.has(key)) {
        throw new ElevenLabsError(
          `advanced_config must not set "api_schema.${key}"; it is a first-class field.`,
          'INVALID_ARGUMENTS',
          `Pass "${key}" as a top-level tool argument instead of inside advanced_config.api_schema.`,
        );
      }
    }
  }
}

function validateMergedToolConfig(merged: unknown): Obj {
  const parsed = mergedToolConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new ElevenLabsError(
      `Merged tool config failed validation (${issues}).`,
      'INVALID_ARGUMENTS',
      'Check the first-class arguments and the advanced_config fragment, then retry.',
    );
  }
  const config = parsed.data as Obj;
  if (config.type === 'webhook' && isObj(config.api_schema)) {
    // Defense in depth: the protected-key check above already guarantees this
    // URL came through the first-class `url` argument (which is validated), but
    // the merged structure is what goes on the wire, so it is what gets the
    // final say.
    validatePublicHttpsUrl('api_schema.url', String(config.api_schema.url));
  }
  return config;
}

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
- type "webhook" requires url, and the url must be a public https:// address (loopback, private, link-local, and cloud-metadata destinations are rejected).
- advanced_config deep-merges LAST, but it must not set first-class fields (type, name, description, expects_response, api_schema.url, api_schema.method) — pass those as top-level arguments; the merged config is revalidated before it is sent.`,
      inputSchema: z.object({
        type: z.enum(['webhook', 'client'])
          .describe('Tool kind: "webhook" calls an HTTP endpoint; "client" is executed by the host application.'),
        name: z.string().min(1)
          .describe('Tool name the agent uses to call it (snake_case recommended).'),
        description: z.string().min(1)
          .describe('When the agent should use this tool and what it does.'),
        url: z.string().url().optional()
          .describe('Webhook endpoint URL. Required when type is "webhook". Must be a public https:// address; loopback, private, link-local, and cloud-metadata destinations are rejected. May include {path_param} placeholders.'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional()
          .describe('HTTP method for webhook tools. Default: ElevenLabs API default (GET).'),
        expects_response: z.boolean().optional()
          .describe('Client tools only: when true, the conversation blocks until the client responds.'),
        advanced_config: z.record(z.unknown()).optional()
          .describe('Optional raw tool_config fragments (request headers, parameter schemas, timeouts). Deep-merged LAST for full-platform reach; first-class fields stay protected and the merged config is revalidated.'),
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
      if (args.type === 'webhook' && args.url) {
        validatePublicHttpsUrl('url', args.url);
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
      if (advancedConfig !== undefined && !isObj(advancedConfig)) {
        throw new ElevenLabsError(
          'advanced_config must be an object.',
          'INVALID_ARGUMENTS',
          'Send advanced_config as a JSON object of tool_config fragments, then retry.',
        );
      }
      if (isObj(advancedConfig)) {
        assertNoFirstClassKeysInAdvancedConfig(advancedConfig, args.type);
      }
      const merged = isObj(advancedConfig)
        ? deepMerge(toolConfig, advancedConfig) as Obj
        : toolConfig;
      const validated = validateMergedToolConfig(merged);

      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.TOOLS,
        { method: 'POST', body: JSON.stringify({ tool_config: validated }) },
      );
      return JSON.stringify({
        ok: true,
        tool: sanitizeAgentTool(result, 'elevenlabs-agents:add_agent_tool'),
        message: `Added ${args.type} tool ${args.name}.`,
      });
    }),
  );
}
