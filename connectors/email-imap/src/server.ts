import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerMailboxTools,
  registerMessageTools,
  registerSendTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'email-imap-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerMailboxTools(server);
  registerMessageTools(server);
  registerSendTools(server);

  return server;
}
