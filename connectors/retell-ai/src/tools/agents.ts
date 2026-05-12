import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    'get_agent',
    {
      description: `Get full configuration of a voice agent including voice, LLM, language, and versioning info.

WHEN TO USE:
- Before making a call, to check the agent's retell_llm_id (needed for update_retell_llm)
- To verify which voice, language, or phone number an agent uses
- To check the agent's current version and published state

COMMON MISTAKES:
- Updating the wrong LLM: use response_engine.llm_id from this tool before update_retell_llm
- Assuming draft changes are live: use get_agent_versions/publish_agent to confirm

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: agent_id not found → list_agents and retry with the returned ID

RELATED TOOLS:
- list_agents: Discover agent IDs
- get_agent_versions: Inspect draft/published versions
- update_retell_llm: Update the linked response_engine.llm_id
- create_phone_call: Use this agent after validating config

RETURNS: agent_id, agent_name, voice_id, response_engine.llm_id, language, version, published/versioning fields, phone number bindings when available.`,
      inputSchema: {
        agent_id: z.string().describe('The agent ID to look up. Use list_agents if you only know the name.'),
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
        `/get-agent/${encodeURIComponent(args.agent_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({ ok: true, ...result });
    }),
  );

  server.registerTool(
    'list_agents',
    {
      description: `List all configured voice agents in your Retell account.

WHEN TO USE:
- Discover available agents before making calls
- Find agent IDs by name
- Inventory check

COMMON MISTAKES:
- Guessing agent IDs from names; use the returned agent_id exactly
- Choosing an agent without checking its response_engine.llm_id and versions via get_agent

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key

RELATED TOOLS:
- get_agent: Inspect full config for a returned agent_id
- get_agent_versions: Check published versions
- create_phone_call/create_web_call: Use a verified agent_id

RETURNS: agents, count. Each agent usually includes agent_id, agent_name, voice_id, response_engine, and timestamps.`,
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
        '/list-agents',
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
      description: `Create a new voice agent with specified voice, LLM, and language settings.

WHEN TO USE:
- Setting up a new voice agent from scratch
- No existing agent fits the use case

WORKFLOW:
1. list_voices → choose voice_id
2. create_retell_llm → create prompt/model config
3. create_agent → point response_engine.llm_id at that LLM
4. publish_agent → make the version live
5. update_phone_number → bind the agent for calls

EXAMPLE:
{ "agent_name": "Sales qualifier", "voice_id": "11labs-Adrian", "response_engine": { "type": "retell-llm", "llm_id": "llm_xxx" }, "language": "en-US" }

COMMON MISTAKES:
- Creating the agent before creating/selecting a Retell LLM
- Forgetting to publish and bind the agent to a phone number before create_phone_call

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: voice_id or llm_id not found → list_voices/list_retell_llms and retry
- 422: invalid config → verify response_engine is { "type": "retell-llm", "llm_id": "..." }

RELATED TOOLS:
- list_voices: Choose a voice_id
- create_retell_llm/list_retell_llms: Choose or create the LLM
- publish_agent: Make the new version live
- update_phone_number: Bind for inbound/outbound calls

RETURNS: agent_id, agent_name, voice_id, response_engine, language, version fields.`,
      inputSchema: {
        agent_name: z.string().optional().describe('Display name for the agent (e.g. "Sales qualifier").'),
        voice_id: z.string().optional().describe('Voice to use. Get valid IDs from list_voices.'),
        response_engine: z.object({
          type: z.enum(['retell-llm']).describe('Response engine type. Currently only "retell-llm" is supported.'),
          llm_id: z.string().describe('Retell LLM ID to use as the response engine. Get from create_retell_llm/list_retell_llms.'),
        }).optional().describe('Response engine configuration linking the agent to an LLM.'),
        language: z.string().optional().describe('Language code (e.g. "en-US", "es-ES"). Default: en-US.'),
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
      const body: Record<string, unknown> = {};
      if (args.agent_name) body.agent_name = args.agent_name;
      if (args.voice_id) body.voice_id = args.voice_id;
      if (args.response_engine) body.response_engine = args.response_engine;
      if (args.language) body.language = args.language;

      const result = await retellFetch<Record<string, unknown>>(
        '/create-agent',
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
      description: `Update an existing agent's configuration (voice, name, response engine, language, etc.).

WHEN TO USE:
- Change voice, language, response engine, responsiveness, or backchannel behavior
- Point an agent at a different Retell LLM

NOTE: This updates the agent's latest DRAFT version. To make changes live, call publish_agent afterward.

COMMON MISTAKES:
- Updating the agent and immediately calling without publish_agent
- Switching response_engine.llm_id without checking the LLM config first

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: agent_id/voice_id/llm_id not found → use list_agents/list_voices/list_retell_llms
- 422: invalid setting range → check numeric ranges on speed/responsiveness/sensitivity

RELATED TOOLS:
- get_agent: Inspect current config before changing
- publish_agent/get_agent_versions: Publish and verify draft changes
- update_retell_llm: Change prompt/model without replacing the response engine

RETURNS: Updated agent object including agent_id, agent_name, voice_id, response_engine, language, draft/version fields.`,
      inputSchema: {
        agent_id: z.string().describe('Agent ID to update. Use get_agent first when unsure.'),
        agent_name: z.string().optional().describe('New display name.'),
        voice_id: z.string().optional().describe('New voice ID. Get IDs from list_voices.'),
        response_engine: z.object({
          type: z.enum(['retell-llm']).describe('Response engine type.'),
          llm_id: z.string().describe('Retell LLM ID.'),
        }).optional().describe('Updated response engine config.'),
        language: z.string().optional().describe('New language code (e.g. "en-US", "es-ES").'),
        voice_speed: z.number().min(0.5).max(2).optional().describe('Speech rate (0.5=slow, 2=fast). Default: 1.'),
        responsiveness: z.number().min(0).max(1).optional().describe('How quickly the agent responds (0=slow, 1=fast). Default: 1.'),
        interruption_sensitivity: z.number().min(0).max(1).optional().describe('How easily user can interrupt (0=never, 1=easy). Default: 1.'),
        enable_backchannel: z.boolean().optional().describe('Whether the agent says "yeah", "uh-huh" during user speech.'),
        ambient_sound: z.enum([
          'coffee-shop',
          'convention-hall',
          'summer-outdoor',
          'mountain-outdoor',
          'static-noise',
          'call-center',
        ]).optional().describe('Background ambience sound.'),
        boosted_keywords: z.array(z.string()).optional().describe('Words to boost in speech recognition (names, brands, etc.).'),
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
      const agentId = args.agent_id;
      const body: Record<string, unknown> = {};
      const fields: ReadonlyArray<keyof typeof args> = [
        'agent_name', 'voice_id', 'response_engine', 'language',
        'voice_speed', 'responsiveness', 'interruption_sensitivity',
        'enable_backchannel', 'ambient_sound', 'boosted_keywords',
      ];
      for (const f of fields) {
        if (args[f] !== undefined) body[f as string] = args[f];
      }

      const result = await retellFetch<Record<string, unknown>>(
        `/update-agent/${encodeURIComponent(agentId)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        ...result,
        message: `Agent ${agentId} updated.`,
      });
    }),
  );

  server.registerTool(
    'publish_agent',
    {
      description: `Publish a specific agent version, making it the active/live version.

WHEN TO USE:
- After updating an agent's config or LLM, to make changes live
- When create_phone_call returns 404 because the agent version is unpublished
- When you need to activate a specific version

CRITICAL: Agent updates go to the latest DRAFT version. They are NOT live until published.
If calls fail with 404, check get_agent_versions and publish the correct version.

WORKFLOW:
1. update_agent or update_retell_llm → changes the draft
2. get_agent_versions → find the version number of the draft
3. publish_agent → make it live

COMMON MISTAKES:
- Publishing the wrong version number; call get_agent_versions immediately before this
- Assuming update_retell_llm alone publishes changes

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: agent/version not found → list_agents/get_agent_versions
- 422: version is invalid or not publishable → verify the draft version number

RELATED TOOLS:
- get_agent_versions: Find the version number to publish
- update_agent/update_retell_llm: Make draft changes first
- create_phone_call: Use the published version afterward

RETURNS: ok, message confirming the agent_id and published version.`,
      inputSchema: {
        agent_id: z.string().describe('Agent ID to publish. Use list_agents/get_agent if needed.'),
        version: z.number().int().min(0).describe('Version number to publish. Get the exact number from get_agent_versions.'),
        version_description: z.string().optional().describe('Optional description of this version (e.g. what prompt/config changed).'),
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
      const agentId = args.agent_id;
      const body: Record<string, unknown> = { version: args.version };
      if (args.version_description) body.version_description = args.version_description;

      await retellFetch<Record<string, unknown>>(
        `/publish-agent-version/${encodeURIComponent(agentId)}`,
        { method: 'POST', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        message: `Agent ${agentId} version ${args.version} published successfully. This version is now live.`,
      });
    }),
  );

  server.registerTool(
    'get_agent_versions',
    {
      description: `List all versions of an agent, including draft and published versions.

WHEN TO USE:
- To check which version is currently published/live
- To find the version number of a draft before publishing
- To debug version mismatch issues causing 404 errors on calls

COMMON MISTAKES:
- Using override_agent_id without checking the matching override_agent_version here
- Publishing/calling a stale version after updating the draft

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: agent_id not found → list_agents and retry

RELATED TOOLS:
- publish_agent: Publish a draft version returned here
- create_phone_call: Pass override_agent_version from this list
- get_agent: Inspect the agent tied to these versions

RETURNS: versions, count. Each version includes version number, published/live status, creation/update timestamps, and description when available.`,
      inputSchema: {
        agent_id: z.string().describe('Agent ID to list versions for. Use list_agents if unknown.'),
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
      const result = await retellFetch<unknown[]>(
        `/get-agent-versions/${encodeURIComponent(args.agent_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        versions: result,
        count: Array.isArray(result) ? result.length : 0,
        message: `Found ${Array.isArray(result) ? result.length : 0} version(s).`,
      });
    }),
  );
}
