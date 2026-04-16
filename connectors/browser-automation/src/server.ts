import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import {
  registerNavigationTools,
  registerInteractionTools,
  registerObservationTools,
  registerSessionTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerNavigationTools(server);
  registerInteractionTools(server);
  registerObservationTools(server);
  registerSessionTools(server);

  return server;
}
