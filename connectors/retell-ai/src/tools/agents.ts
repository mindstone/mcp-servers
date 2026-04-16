import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    'get_agent',
    {
      description: `Get full configuration of a voice agent — voice, LLM, phone number, and behavior settings.

WHEN TO USE:
- Before making a call, to check the agent's current setup
- To find the agent's retell_llm_id (needed for update_retell_llm)
- To verify which voice, language, or phone number an agent uses

RETURNS: Full agent configuration object including agent_id, agent_name, voice_id, response_engine.llm_id, language.`,
      inputSchema: {
        agent_id: z.string().describe('The agent ID to look up.'),
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
        `/v2/get-agent/${encodeURIComponent(args.agent_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({ ok: true, ...result });
    }),
  );

  server.registerTool(
    'list_agents',
    {
      description: `List all configured voice agents in your Retell AI account.

WHEN TO USE:
- User asks "what agents do I have?" or "show me my agents"
- Need to find an agent_id before making a call
- Browsing available agents to pick the right one

RETURNS: Array of agent objects with agent_id, agent_name, voice_id, language, and creation timestamps.`,
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
        '/v2/list-agents',
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        agents: result,
        count: Array.isArray(result) ? result.length : 0,
        message: `Found ${Array.isArray(result) ? result.length : 0} agent(s).`,
      });
    }),
  );

  server.registerTool(
    'create_agent',
    {
      description: `Create a new voice agent. Agents are the core unit in Retell — they combine a voice, an LLM, and behavior settings.

WORKFLOW:
1. list_voices → pick a voice
2. create_retell_llm → create LLM config with the agent's prompt
3. create_agent → create the agent linking voice + LLM
4. Assign a phone number or use create_web_call to test

NOTE: All parameters are optional. A minimal agent can be created with just agent_name.

RETURNS: Full agent object with generated agent_id.`,
      inputSchema: {
        agent_name: z.string().optional().describe('Display name for the agent.'),
        voice_id: z.string().optional().describe('Voice to use. Get IDs from list_voices.'),
        response_engine: z.object({
          type: z.enum(['retell-llm']).describe('Response engine type. Currently only "retell-llm" is supported.'),
          llm_id: z.string().describe('Retell LLM ID to use as the response engine.'),
        }).optional().describe('Response engine configuration linking the agent to an LLM.'),
        language: z.string().optional().describe('Language code (e.g. "en-US", "es-ES"). Default: en-US.'),
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
      if (args.agent_name) body.agent_name = args.agent_name;
      if (args.voice_id) body.voice_id = args.voice_id;
      if (args.response_engine) body.response_engine = args.response_engine;
      if (args.language) body.language = args.language;

      const result = await retellFetch<Record<string, unknown>>(
        '/v2/create-agent',
        { method: 'POST', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        ...result,
        message: `Agent created (agent_id: ${result.agent_id}). You can now assign it to a phone number or use create_web_call to test it.`,
      });
    }),
  );

  server.registerTool(
    'update_agent',
    {
      description: `Update an existing voice agent's configuration — name, voice, LLM, or language.

Only provide the fields you want to change. Omitted fields remain unchanged.

RETURNS: Updated agent object.`,
      inputSchema: {
        agent_id: z.string().describe('Agent ID to update.'),
        agent_name: z.string().optional().describe('New display name.'),
        voice_id: z.string().optional().describe('New voice ID. Get IDs from list_voices.'),
        response_engine: z.object({
          type: z.enum(['retell-llm']).describe('Response engine type.'),
          llm_id: z.string().describe('Retell LLM ID.'),
        }).optional().describe('Updated response engine config.'),
        language: z.string().optional().describe('New language code (e.g. "en-US", "es-ES").'),
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
      const agentId = args.agent_id;
      const body: Record<string, unknown> = {};
      if (args.agent_name !== undefined) body.agent_name = args.agent_name;
      if (args.voice_id !== undefined) body.voice_id = args.voice_id;
      if (args.response_engine !== undefined) body.response_engine = args.response_engine;
      if (args.language !== undefined) body.language = args.language;

      const result = await retellFetch<Record<string, unknown>>(
        `/v2/update-agent/${encodeURIComponent(agentId)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        ...result,
        message: `Agent ${agentId} updated.`,
      });
    }),
  );
}
