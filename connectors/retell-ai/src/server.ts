import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import {
  registerCallTools,
  registerAgentTools,
  registerLlmTools,
  registerVoiceTools,
  registerConfigTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerCallTools(server);
  registerAgentTools(server);
  registerLlmTools(server);
  registerVoiceTools(server);
  registerConfigTools(server);

  return server;
}
