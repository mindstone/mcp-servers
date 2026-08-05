import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerSequenceTools,
  registerMessageTools,
  registerSnippetTools,
  registerMeetingTools,
  registerUserTools,
  registerReportTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'mixmax-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerSequenceTools(server);
  registerMessageTools(server);
  registerSnippetTools(server);
  registerMeetingTools(server);
  registerUserTools(server);
  registerReportTools(server);

  return server;
}
