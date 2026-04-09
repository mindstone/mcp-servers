import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerWorkerTools,
  registerOrganizationTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'workday-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerWorkerTools(server);
  registerOrganizationTools(server);

  return server;
}
