import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerGenerateTools,
  registerEditTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'nano-banana-mcp-server',
    version: '0.3.0',
  });

  registerConfigureTools(server);
  registerGenerateTools(server);
  registerEditTools(server);

  return server;
}
