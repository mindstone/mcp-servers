import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConfigureTools, registerTicketTools, registerFieldTools } from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'freshdesk-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerTicketTools(server);
  registerFieldTools(server);

  return server;
}
