import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import { resolveAuthMode } from './auth.js';
import {
  registerAuthTools,
  registerProspectTools,
  registerSequenceTools,
  registerSequenceContentTools,
  registerAccountTools,
  registerTaskTools,
  registerMailingTools,
  registerCallTools,
  registerUserTools,
} from './tools/index.js';

export function createServer(): McpServer {
  // Resolve auth mode once at startup
  resolveAuthMode();

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerAuthTools(server);
  registerProspectTools(server);
  registerSequenceTools(server);
  registerSequenceContentTools(server);
  registerAccountTools(server);
  registerTaskTools(server);
  registerMailingTools(server);
  registerCallTools(server);
  registerUserTools(server);

  return server;
}
