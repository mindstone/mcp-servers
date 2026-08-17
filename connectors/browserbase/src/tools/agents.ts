import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserbaseFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { EPOCH_MS_FIELD_HINT, epochMsField, epochMsToIso } from './common.js';
import { sanitizeAgent, sanitizeList } from '../sanitize.js';

const resultSchemaField = z.record(z.unknown()).optional()
  .describe('JSON Schema object the run/agent result should conform to (e.g. {"type":"object","properties":{"price":{"type":"number"}}}).');

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    'create_agent',
    {
      description: `Create a reusable web agent: a named bundle of system prompt + optional result schema that agent runs can reference by ID.

WHEN TO USE:
- You run the same kind of browser task repeatedly and want a stable, reusable prompt
- You want every run's result to conform to a fixed JSON schema

NOTE: An agent is optional — create_agent_run works ad-hoc without one. Create an agent when the same task shape recurs.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 400: invalid parameters → name must be 1-255 chars; resultSchema must be a JSON Schema object

RELATED TOOLS:
- create_agent_run: Start a run referencing this agent_id
- list_agents / get_agent: Discover and inspect agents
- update_agent / delete_agent: Lifecycle management

RETURNS: agentId, name, systemPrompt, resultSchema, createdAt, updatedAt.`,
      inputSchema: {
        name: z.string().min(1).max(255)
          .describe('Human-readable agent name, 1-255 characters (e.g. "Pricing extractor").'),
        system_prompt: z.string().min(1).optional()
          .describe('System prompt applied to every run that uses this agent (e.g. "You extract product pricing. Always return JSON. Cite the page URL.").'),
        result_schema: resultSchemaField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const body: Record<string, unknown> = { name: args.name };
      if (args.system_prompt) body.systemPrompt = args.system_prompt;
      if (args.result_schema) body.resultSchema = args.result_schema;

      const result = await browserbaseFetch<Record<string, unknown>>(
        '/agents',
        { method: 'POST', body },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeAgent(result, 'browserbase:create_agent') as Record<string, unknown>),
        message: `Agent created (agentId: ${result.agentId}). Start a run with create_agent_run(task, agent_id).`,
      });
    }),
  );

  server.registerTool(
    'list_agents',
    {
      description: `List reusable agents, cursor-paginated, optionally filtered by creation date.

WHEN TO USE:
- Discover agent IDs by name before create_agent_run
- Inventory check

PAGINATION: Pass the returned next_cursor as cursor to get the next page; when next_cursor is absent there are no more pages.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key

RELATED TOOLS:
- get_agent: Full details for one agent
- create_agent_run: Run an agent you find here

RETURNS: agents, count, next_cursor. Each agent includes agentId, name, systemPrompt, resultSchema, createdAt, updatedAt.`,
      inputSchema: {
        start_at: epochMsField().optional()
          .describe(`Only agents created at or after this time. ${EPOCH_MS_FIELD_HINT}`),
        end_at: epochMsField().optional()
          .describe(`Only agents created at or before this time. ${EPOCH_MS_FIELD_HINT}`),
        limit: z.number().int().min(1).max(1000).optional()
          .describe('Page size (1-1000). Default: 20.'),
        cursor: z.string().optional()
          .describe('Pagination cursor from a previous response\'s next_cursor.'),
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
      const result = await browserbaseFetch<Record<string, unknown>>('/agents', {
        method: 'GET',
        query: {
          startAt: args.start_at !== undefined ? epochMsToIso(args.start_at) : undefined,
          endAt: args.end_at !== undefined ? epochMsToIso(args.end_at) : undefined,
          limit: args.limit,
          cursor: args.cursor,
        },
      });
      const agents = sanitizeList(result.data, sanitizeAgent, 'browserbase:list_agents');
      return JSON.stringify({
        ok: true,
        agents,
        count: agents.length,
        next_cursor: result.nextCursor,
        message: `Found ${agents.length} agent(s)${result.nextCursor ? ' — more available; pass next_cursor as cursor for the next page' : ''}.`,
      });
    }),
  );

  server.registerTool(
    'get_agent',
    {
      description: `Get a reusable agent's full configuration: name, system prompt, and result schema.

WHEN TO USE:
- Review the prompt before starting a run with this agent
- Confirm the result schema a run will conform to

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: agent_id not found → list_agents and retry with a returned ID

RELATED TOOLS:
- update_agent: Change the prompt or schema
- create_agent_run: Run this agent

RETURNS: agentId, name, systemPrompt, resultSchema, createdAt, updatedAt.`,
      inputSchema: {
        agent_id: z.string().min(1).describe('The agent ID (from list_agents or create_agent).'),
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
      const result = await browserbaseFetch<Record<string, unknown>>(
        `/agents/${encodeURIComponent(args.agent_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeAgent(result, 'browserbase:get_agent') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'update_agent',
    {
      description: `Update a reusable agent's name, system prompt, or result schema (partial update — omitted fields stay unchanged).

WHEN TO USE:
- Iterate on an agent's prompt without recreating it
- Change the result schema for future runs

NOTE: Updates apply to runs started AFTER the change; already-running runs keep the configuration they started with.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: agent_id not found → list_agents and retry

RELATED TOOLS:
- get_agent: Review current config before changing it
- create_agent_run: Start a run with the updated agent

RETURNS: the updated agent (agentId, name, systemPrompt, resultSchema, createdAt, updatedAt).`,
      inputSchema: {
        agent_id: z.string().min(1).describe('The agent ID to update (from list_agents).'),
        name: z.string().min(1).max(255).optional()
          .describe('New human-readable name, 1-255 characters.'),
        system_prompt: z.string().min(1).optional()
          .describe('New system prompt applied to every future run of this agent.'),
        result_schema: resultSchemaField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.system_prompt !== undefined) body.systemPrompt = args.system_prompt;
      if (args.result_schema !== undefined) body.resultSchema = args.result_schema;

      const result = await browserbaseFetch<Record<string, unknown>>(
        `/agents/${encodeURIComponent(args.agent_id)}`,
        { method: 'PATCH', body },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeAgent(result, 'browserbase:update_agent') as Record<string, unknown>),
        message: `Agent ${args.agent_id} updated. New runs will use the updated configuration.`,
      });
    }),
  );

  server.registerTool(
    'delete_agent',
    {
      description: `Delete a reusable agent. Existing and in-flight runs that referenced it are UNAFFECTED — they keep their snapshot of the prompt/schema.

WHEN TO USE:
- Remove an obsolete or test agent

NOTE: Deletion is permanent for the agent itself; there is no undo, but past runs and their results remain queryable via list_agent_runs / get_agent_run.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: agent_id not found → it may already be deleted (deletion is idempotent upstream)

RELATED TOOLS:
- list_agents / get_agent: Confirm the agent before deleting
- create_agent: Create a replacement

RETURNS: ok, message. Browserbase returns HTTP 204 on success.`,
      inputSchema: {
        agent_id: z.string().min(1).describe('The agent ID to delete. Confirm with get_agent first.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      await browserbaseFetch<Record<string, unknown>>(
        `/agents/${encodeURIComponent(args.agent_id)}`,
        { method: 'DELETE' },
      );
      return JSON.stringify({
        ok: true,
        message: `Agent ${args.agent_id} deleted. Runs that already used it are unaffected.`,
      });
    }),
  );
}
