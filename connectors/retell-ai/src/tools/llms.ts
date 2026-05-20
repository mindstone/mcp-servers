import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { internal as precallInternal } from '../precall-checks.js';

const { extractReferencedTokens } = precallInternal;

const MODEL_OPTIONS_HINT = 'Options: gpt-4.1, gpt-4.1-mini, gpt-5, gpt-5-mini, gpt-5.5, claude-4.5-sonnet, claude-4.6-sonnet, claude-4.5-haiku, gemini-2.5-flash-lite, gemini-3.0-flash, gemini-3.1-flash-lite.';

export function registerLlmTools(server: McpServer): void {
  server.registerTool(
    'update_retell_llm',
    {
      description: `Update a Retell LLM response engine's prompt, model, or behavior settings.

WHEN TO USE:
- Before making a call, to set the conversation instructions/prompt
- To change the LLM model or temperature
- To update the agent's opening message

CRITICAL: This is the #1 most important step before any phone call. The general_prompt controls what the agent says. If you skip this, the agent will use the PREVIOUS call's prompt.

WORKFLOW:
1. get_agent → find the agent's retell_llm_id (in response_engine.llm_id)
2. update_retell_llm → set the prompt and behavior
3. get_agent_versions/publish_agent if the agent version needs publishing
4. Wait 2-3 seconds for propagation
5. create_phone_call

MODEL OPTIONS: gpt-4.1, gpt-4.1-mini, gpt-5, gpt-5-mini, gpt-5.5, claude-4.5-sonnet, claude-4.6-sonnet, claude-4.5-haiku, gemini-2.5-flash-lite, gemini-3.0-flash, gemini-3.1-flash-lite.

EXAMPLE:
{ "llm_id": "llm_xxx", "general_prompt": "You are calling to confirm tomorrow's appointment. Be concise and polite.", "begin_message": "Hi, this is Alex calling to confirm your appointment.", "model": "gpt-5.5" }

COMMON MISTAKES:
- Skipping this before create_phone_call, causing the previous call's prompt to run
- Updating the wrong llm_id; get it from get_agent.response_engine.llm_id
- Forgetting to publish the agent/version after changing call behavior

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: llm_id not found → get_agent or list_retell_llms
- 422: invalid model/prompt/tools → use a listed model and valid JSON tool config

RELATED TOOLS:
- get_agent: Find the linked response_engine.llm_id
- get_retell_llm: Inspect current prompt/model before changing
- publish_agent/get_agent_versions: Make agent changes live
- create_phone_call/create_web_call: Test the updated behavior

RETURNS: llm_id, general_prompt, begin_message, model, model_temperature, general_tools, updated timestamps.`,
      inputSchema: {
        llm_id: z.string().describe('The LLM config ID to update. Get from get_agent → response_engine.llm_id or list_retell_llms.'),
        general_prompt: z.string().optional().describe('System prompt/instructions for the voice agent. This controls what the agent says; update it before each call-specific scenario.'),
        begin_message: z.string().optional().describe('First message the agent speaks when the call connects (e.g. "Hi, this is Sarah from Acme Corp.").'),
        model: z.string().optional().describe(`LLM model. ${MODEL_OPTIONS_HINT}`),
        model_temperature: z.number().min(0).max(2).optional().describe('Temperature (0=deterministic, 2=creative). Default: varies by model.'),
        general_tools: z.array(z.unknown()).optional().describe('Tools available to the LLM during calls (advanced). Must match Retell tool schema.'),
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
      const llmId = args.llm_id;
      const body: Record<string, unknown> = {};
      if (args.general_prompt !== undefined) body.general_prompt = args.general_prompt;
      if (args.begin_message !== undefined) body.begin_message = args.begin_message;
      if (args.model !== undefined) body.model = args.model;
      if (args.model_temperature !== undefined) body.model_temperature = args.model_temperature;
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
      description: `Get details of a Retell LLM response engine (prompt, model, tools).

WHEN TO USE:
- Inspect current prompt/model before update_retell_llm
- Confirm which prompt an agent will use before a call
- Debug why an agent said the wrong thing

COMMON MISTAKES:
- Looking at the agent only; the actual call instructions live in the Retell LLM
- Editing a different LLM than the one returned by get_agent.response_engine.llm_id

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 404: llm_id not found → get_agent/list_retell_llms and retry

RELATED TOOLS:
- get_agent: Find response_engine.llm_id for an agent
- update_retell_llm: Change the prompt/model
- list_retell_llms: Browse available LLM configs

RETURNS: llm_id, general_prompt, begin_message, model, model_temperature, general_tools, timestamps.`,
      inputSchema: {
        llm_id: z.string().describe('The Retell LLM config ID. Usually get this from get_agent → response_engine.llm_id.'),
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

      const prompt = typeof result.general_prompt === 'string' ? result.general_prompt : undefined;
      const beginMsg = typeof result.begin_message === 'string' ? result.begin_message : undefined;
      const referencedVars = extractReferencedTokens(prompt, beginMsg);
      const varList = [...referencedVars].sort();

      const dynamicVariableAnalysis: Record<string, unknown> = {
        supported: varList.length > 0,
        variables: varList,
      };

      if (varList.length === 0) {
        dynamicVariableAnalysis.warning =
          'This prompt does NOT contain any {{variable_name}} placeholders. ' +
          'Passing retell_llm_dynamic_variables to create_phone_call/create_web_call will have NO EFFECT — ' +
          'the variables will be silently dropped. To inject call-specific context, you MUST call ' +
          'update_retell_llm to modify the general_prompt (adding {{placeholders}} or rewriting it entirely) before placing the call.';
      } else {
        dynamicVariableAnalysis.note =
          `This prompt references ${varList.length} dynamic variable(s): ${varList.map((v) => `{{${v}}}`).join(', ')}. ` +
          'You can pass these via retell_llm_dynamic_variables on create_phone_call/create_web_call. ' +
          'Any variable NOT in this list will be silently ignored.';
      }

      return JSON.stringify({ ok: true, ...result, dynamic_variable_analysis: dynamicVariableAnalysis });
    }),
  );

  server.registerTool(
    'create_retell_llm',
    {
      description: `Create a new Retell LLM response engine with prompt and model settings.

WHEN TO USE:
- Creating a new agent that needs its own prompt/model config
- Separating a new call workflow from an existing agent's LLM
- Testing a new prompt without overwriting a production LLM

WORKFLOW: Create the LLM first, then create_agent with response_engine: { "type": "retell-llm", "llm_id": "<returned llm_id>" }.

EXAMPLE:
{ "general_prompt": "You confirm appointment times and answer basic scheduling questions.", "begin_message": "Hi, I'm calling to confirm your appointment.", "model": "gpt-5.5" }

MODEL OPTIONS: gpt-4.1, gpt-4.1-mini, gpt-5, gpt-5-mini, gpt-5.5, claude-4.5-sonnet, claude-4.6-sonnet, claude-4.5-haiku, gemini-2.5-flash-lite, gemini-3.0-flash, gemini-3.1-flash-lite.

COMMON MISTAKES:
- Creating multiple near-identical LLMs instead of updating the existing one
- Creating the LLM but never attaching it to an agent

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 422: invalid model/prompt → use a listed model and non-empty prompt

RELATED TOOLS:
- list_retell_llms/get_retell_llm: Reuse or inspect existing configs
- create_agent/update_agent: Attach the new llm_id to an agent
- update_retell_llm: Modify this config later

RETURNS: llm_id, general_prompt, begin_message, model, model_temperature, general_tools, timestamps.`,
      inputSchema: {
        general_prompt: z.string().optional().describe('System prompt/instructions for the voice agent. Keep it call-ready and explicit.'),
        begin_message: z.string().optional().describe('First message spoken when the call connects.'),
        model: z.string().optional().describe(`LLM model. ${MODEL_OPTIONS_HINT}`),
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
      description: `List all Retell LLM response engine configurations.

WHEN TO USE:
- Find llm_id values before get_retell_llm/update_retell_llm
- Inventory prompt/model configurations
- Decide whether to reuse an LLM or create a new one

COMMON MISTAKES:
- Updating an arbitrary llm_id without checking which agent uses it
- Assuming list order implies which LLM is active; use get_agent to confirm bindings

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_retell_api_key
- 422: invalid pagination params → keep limit between 1 and 1000

RELATED TOOLS:
- get_retell_llm: Inspect one returned llm_id
- update_retell_llm: Change prompt/model
- get_agent/list_agents: See which agents reference each LLM
- create_retell_llm: Create a separate config when reuse is unsafe

RETURNS: llms, count, pagination_key, has_more. Each LLM includes llm_id, prompt/model fields, and timestamps when available.`,
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Max results to return (default: 50, max: 1000).'),
        pagination_key: z.string().optional().describe('Pagination key from the previous response for the next page.'),
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
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.pagination_key) params.set('pagination_key', args.pagination_key);
      const qs = params.toString();

      const result = await retellFetch<unknown>(
        `/v2/list-retell-llms${qs ? `?${qs}` : ''}`,
        { method: 'GET' },
      );

      const resultObj = (result && typeof result === 'object' && !Array.isArray(result))
        ? result as Record<string, unknown>
        : null;
      const items = resultObj && Array.isArray(resultObj.items)
        ? (resultObj.items as unknown[])
        : (Array.isArray(result) ? result as unknown[] : []);

      return JSON.stringify({
        ok: true,
        llms: items,
        count: items.length,
        pagination_key: resultObj?.pagination_key,
        has_more: resultObj?.has_more,
        message: `Found ${items.length} LLM config(s).`,
      });
    }),
  );
}
