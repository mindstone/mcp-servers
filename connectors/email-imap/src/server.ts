import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerMailboxTools,
  registerMessageTools,
  registerSendTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'email-imap-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerMailboxTools(server);
  registerMessageTools(server);
  registerSendTools(server);

  return server;
}
