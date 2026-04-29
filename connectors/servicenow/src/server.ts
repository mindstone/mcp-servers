import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerIncidentTools,
  registerChangeTools,
  registerKnowledgeTools,
  registerUserTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'servicenow-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerIncidentTools(server);
  registerChangeTools(server);
  registerKnowledgeTools(server);
  registerUserTools(server);

  return server;
}
