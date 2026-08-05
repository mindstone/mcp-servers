import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConfigureTools, registerTicketTools, registerFieldTools, registerAgentTools, registerContactTools, registerSolutionTools } from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'freshdesk-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerTicketTools(server);
  registerFieldTools(server);
  registerAgentTools(server);
  registerContactTools(server);
  registerSolutionTools(server);

  return server;
}
