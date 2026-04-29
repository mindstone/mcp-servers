import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerWorkerTools,
  registerOrganizationTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'workday-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerWorkerTools(server);
  registerOrganizationTools(server);

  return server;
}
