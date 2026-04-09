import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerMeetingTools,
  registerTeamTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'fathom-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerMeetingTools(server);
  registerTeamTools(server);

  return server;
}
