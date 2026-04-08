import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAccountTools,
  registerTicketTools,
  registerUserTools,
  registerCommentTools,
  registerDiscoveryTools,
  registerMacroTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'zendesk-mcp-server',
    version: '0.2.1-rc.2',
  });

  registerAccountTools(server);
  registerTicketTools(server);
  registerUserTools(server);
  registerCommentTools(server);
  registerDiscoveryTools(server);
  registerMacroTools(server);

  return server;
}
