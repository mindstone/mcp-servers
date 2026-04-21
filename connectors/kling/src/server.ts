import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConfigureTools, registerVideoTools } from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'kling-mcp-server',
    version: '0.3.0',
  });

  registerConfigureTools(server);
  registerVideoTools(server);

  return server;
}
