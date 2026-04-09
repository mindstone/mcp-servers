import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerDocumentTools,
  registerTemplateTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'pandadoc-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerDocumentTools(server);
  registerTemplateTools(server);

  return server;
}
