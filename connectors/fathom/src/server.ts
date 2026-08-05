import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerMeetingTools,
  registerTeamTools,
  registerRecordingTools,
  registerWebhookTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'fathom-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerMeetingTools(server);
  registerTeamTools(server);
  registerRecordingTools(server);
  registerWebhookTools(server);

  return server;
}
