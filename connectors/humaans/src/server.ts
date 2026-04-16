import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerPeopleTools,
  registerJobRoleTools,
  registerCompanyTools,
  registerTimeAwayTools,
  registerDicerollTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'humaans-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerPeopleTools(server);
  registerJobRoleTools(server);
  registerCompanyTools(server);
  registerTimeAwayTools(server);

  return server;
}
