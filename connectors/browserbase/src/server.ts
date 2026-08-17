import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import {
  registerAgentRunTools,
  registerAgentTools,
  registerCertificateTools,
  registerConfigTools,
  registerContextTools,
  registerDownloadTools,
  registerExtensionTools,
  registerFunctionTools,
  registerProjectTools,
  registerSessionTools,
  registerWebTools,
} from './tools/index.js';

const SERVER_INSTRUCTIONS = `Browserbase cloud browser connector — sessions, AI web agents, persistent contexts, downloads, extensions, certificates, server-side fetch/search, and serverless functions.

CRITICAL WORKFLOWS:
1. Quick page content → fetch_url (no session needed). Interactive or JS-heavy tasks → create_agent_run or create_session.
2. Agent runs: create_agent_run → wait_for_agent_run (recommended; polls until terminal and returns the result). Never assume a run is finished from create_agent_run's response — runs start PENDING.
3. Sessions bill per browser-minute with a 1-minute minimum: end sessions with end_session as soon as you are done. 429 errors mean the concurrency limit is hit — end unused sessions or wait for the retry-after window.
4. There are NO webhooks: everything async (agent runs, recording downloads, function invocations) is polled.

COMMON MISTAKES:
- Sharing connectUrl/debugger URLs publicly — they grant live control of the browser.
- Expecting list endpoints for contexts or extensions — neither exists; record IDs returned at creation.
- Passing sensitive values directly in agent run tasks — use the variables map and %name% placeholders instead; values are substituted at runtime and never appear in logs.
- Using the deprecated GET /sessions/{id}/recording (rrweb) endpoint — it is gone upstream; use get_session_replays or the recording-download tools.`;

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

  registerConfigTools(server);
  registerProjectTools(server);
  registerSessionTools(server);
  registerContextTools(server);
  registerAgentTools(server);
  registerAgentRunTools(server);
  registerDownloadTools(server);
  registerExtensionTools(server);
  registerCertificateTools(server);
  registerWebTools(server);
  registerFunctionTools(server);

  return server;
}
