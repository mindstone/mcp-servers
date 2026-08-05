import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAccountTools,
  registerAdminTools,
  registerAudienceExportTools,
  registerReportTools,
  registerSchemaTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'google-analytics-mcp-server',
    version: pkg.version,
  });

  registerAccountTools(server);
  registerSchemaTools(server);
  registerReportTools(server);
  registerAdminTools(server);
  registerAudienceExportTools(server);

  return server;
}
