import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAccountTools,
  registerTicketTools,
  registerUserTools,
  registerCommentTools,
  registerDiscoveryTools,
  registerMacroTools,
  registerHelpCenterTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'zendesk-mcp-server',
    version: pkg.version,
  });

  registerAccountTools(server);
  registerTicketTools(server);
  registerUserTools(server);
  registerCommentTools(server);
  registerDiscoveryTools(server);
  registerMacroTools(server);
  registerHelpCenterTools(server);

  return server;
}
