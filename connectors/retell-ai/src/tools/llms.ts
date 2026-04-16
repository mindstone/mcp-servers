import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerLlmTools(server: McpServer): void {
  server.registerTool(
    'update_retell_llm',
    {
      description: `Update the LLM configuration that controls what a voice agent says during calls. This is the most important tool for customizing agent behavior.

HOW TO FIND THE LLM ID:
1. get_agent(agent_id) → response_engine.llm_id
2. Use that llm_id with this tool

KEY FIELDS:
- general_prompt: The system prompt — controls the agent's personality, instructions, and behavior
- begin_message: First thing the agent says when the call connects
- model: LLM model to use (e.g. "gpt-4o", "claude-3.5-sonnet")

IMPORTANT: After updating, wait 2-3 seconds before creating a call to let the config propagate.

RETURNS: Updated LLM configuration object.`,
      inputSchema: {
        llm_id: z.string().describe('The LLM config ID to update. Get this from get_agent → response_engine.llm_id.'),
        general_prompt: z.string().optional().describe('The system prompt / instructions for the voice agent.'),
        begin_message: z.string().optional().describe('The first message the agent speaks when the call connects.'),
        model: z.string().optional().describe('LLM model to use (e.g. "gpt-4o", "claude-3.5-sonnet").'),
        general_tools: z.array(z.unknown()).optional().describe('Tools available to the LLM during calls (advanced).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const llmId = args.llm_id;
      const body: Record<string, unknown> = {};
      if (args.general_prompt !== undefined) body.general_prompt = args.general_prompt;
      if (args.begin_message !== undefined) body.begin_message = args.begin_message;
      if (args.model !== undefined) body.model = args.model;
      if (args.general_tools !== undefined) body.general_tools = args.general_tools;

      const result = await retellFetch<Record<string, unknown>>(
        `/update-retell-llm/${encodeURIComponent(llmId)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        ...result,
        message: `LLM config ${llmId} updated. Wait 2-3 seconds before creating a call to let the config propagate.`,
      });
    }),
  );

  server.registerTool(
    'get_retell_llm',
    {
      description: `Get the full LLM configuration — prompt, greeting, model, and tools.

HOW TO FIND THE LLM ID:
get_agent(agent_id) → response_engine.llm_id

RETURNS: Full LLM config including general_prompt, begin_message, model, and general_tools.`,
      inputSchema: {
        llm_id: z.string().describe('The LLM config ID. Get from get_agent → response_engine.llm_id.'),
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
        `/get-retell-llm/${encodeURIComponent(args.llm_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({ ok: true, ...result });
    }),
  );

  server.registerTool(
    'create_retell_llm',
    {
      description: `Create a new LLM configuration for use with a voice agent.

WORKFLOW:
1. create_retell_llm → get llm_id
2. create_agent with response_engine: { type: "retell-llm", llm_id: "<new_id>" }

RETURNS: New LLM config object with generated llm_id.`,
      inputSchema: {
        general_prompt: z.string().optional().describe('System prompt for the voice agent.'),
        begin_message: z.string().optional().describe('First message spoken when call connects.'),
        model: z.string().optional().describe('LLM model to use (e.g. "gpt-4o", "claude-3.5-sonnet").'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const body: Record<string, unknown> = {};
      if (args.general_prompt !== undefined) body.general_prompt = args.general_prompt;
      if (args.begin_message !== undefined) body.begin_message = args.begin_message;
      if (args.model !== undefined) body.model = args.model;

      const result = await retellFetch<Record<string, unknown>>(
        '/create-retell-llm',
        { method: 'POST', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        ...result,
        message: `LLM config created (llm_id: ${result.llm_id}). Use this llm_id when creating or updating an agent's response_engine.`,
      });
    }),
  );

  server.registerTool(
    'list_retell_llms',
    {
      description: `List all LLM configurations in your Retell AI account.

WHEN TO USE:
- Browsing available LLM configs
- Finding the right llm_id before linking it to an agent

RETURNS: Array of LLM config objects with llm_id, general_prompt, model, and timestamps.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      requireApiKey();
      const result = await retellFetch<unknown[]>(
        '/list-retell-llm',
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        llms: result,
        count: Array.isArray(result) ? result.length : 0,
        message: `Found ${Array.isArray(result) ? result.length : 0} LLM config(s).`,
      });
    }),
  );
}
