import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerPeopleTools,
  registerJobRoleTools,
  registerCompanyTools,
  registerTimeAwayTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'humaans-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerPeopleTools(server);
  registerJobRoleTools(server);
  registerCompanyTools(server);
  registerTimeAwayTools(server);

  return server;
}
