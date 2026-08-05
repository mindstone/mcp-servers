import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerDocumentTools,
  registerTemplateTools,
  registerDiscoveryTools,
  registerContentLibraryTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'pandadoc-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerDocumentTools(server);
  registerTemplateTools(server);
  registerDiscoveryTools(server);
  registerContentLibraryTools(server);

  return server;
}
