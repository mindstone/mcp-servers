import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConfigureTools, registerGenerationTools, registerDownloadTools } from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'napkin-mcp-server',
    version: '0.3.0',
  });

  registerConfigureTools(server);
  registerGenerationTools(server);
  registerDownloadTools(server);

  return server;
}
