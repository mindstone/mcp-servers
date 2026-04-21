import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConfigureTools, registerGenerationTools, registerListingTools } from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'gamma-mcp-server',
    version: '0.3.0',
  });

  registerConfigureTools(server);
  registerGenerationTools(server);
  registerListingTools(server);

  return server;
}
