import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import { resolveAuthMode } from './auth.js';
import {
  registerAuthTools,
  registerAccountTools,
  registerContactTools,
  registerOpportunityTools,
  registerLeadTools,
  registerTaskTools,
  registerCaseTools,
  registerEventTools,
  registerSearchTools,
  registerUserTools,
  registerQueryTools,
} from './tools/index.js';

export function createServer(): McpServer {
  resolveAuthMode();

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerAuthTools(server);
  registerAccountTools(server);
  registerContactTools(server);
  registerOpportunityTools(server);
  registerLeadTools(server);
  registerTaskTools(server);
  registerCaseTools(server);
  registerEventTools(server);
  registerSearchTools(server);
  registerUserTools(server);
  registerQueryTools(server);

  return server;
}
