import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerIncidentTools,
  registerChangeTools,
  registerKnowledgeTools,
  registerUserTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'servicenow-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerIncidentTools(server);
  registerChangeTools(server);
  registerKnowledgeTools(server);
  registerUserTools(server);

  return server;
}
