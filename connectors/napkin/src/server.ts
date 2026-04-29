import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConfigureTools, registerGenerationTools, registerDownloadTools } from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'napkin-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerGenerationTools(server);
  registerDownloadTools(server);

  return server;
}
