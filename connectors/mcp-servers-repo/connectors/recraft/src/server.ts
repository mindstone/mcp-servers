import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerGenerationTools,
  registerStylesTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'recraft-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerGenerationTools(server);
  registerStylesTools(server);

  return server;
}
