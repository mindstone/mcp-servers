import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import {
  registerCallTools,
  registerBatchCallTools,
  registerAgentTools,
  registerLlmTools,
  registerVoiceTools,
  registerConfigTools,
} from './tools/index.js';

const SERVER_INSTRUCTIONS = `Retell AI voice agent connector — phone calls, agent configuration, and call management.

CRITICAL WORKFLOW — Before placing any call:
1. list_agents → find the agent_id
2. get_agent → get response_engine.llm_id
3. get_retell_llm → read the current prompt and check which {{dynamic_variables}} it supports
4. update_retell_llm → set the prompt/instructions for THIS call's purpose
5. Wait 2-3s for propagation
6. create_phone_call → place the call

DYNAMIC VARIABLES WARNING:
retell_llm_dynamic_variables on create_phone_call/create_web_call only work if the agent's LLM prompt already contains matching {{variable_name}} placeholders. If the prompt doesn't reference them, they are SILENTLY DROPPED and the call runs with the existing prompt unchanged. Always check get_retell_llm first — the response tells you which variables the prompt supports. If you need to inject new context, update_retell_llm is the reliable path.

COMMON MISTAKE: Skipping update_retell_llm and relying on dynamic variables alone. Unless the prompt was specifically authored with {{placeholders}}, this results in the previous call's prompt running again.`;

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerCallTools(server);
  registerBatchCallTools(server);
  registerAgentTools(server);
  registerLlmTools(server);
  registerVoiceTools(server);
  registerConfigTools(server);

  return server;
}
