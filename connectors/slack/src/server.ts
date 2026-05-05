import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import {
  registerAuthTools,
  registerChannelTools,
  registerFileTools,
  registerMessageTools,
  registerReactionTools,
  registerThreadTools,
  registerUserTools,
  registerWorkspaceTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerAuthTools(server);
  registerMessageTools(server);
  registerChannelTools(server);
  registerThreadTools(server);
  registerReactionTools(server);
  registerUserTools(server);
  registerFileTools(server);
  registerWorkspaceTools(server);

  return server;
}
