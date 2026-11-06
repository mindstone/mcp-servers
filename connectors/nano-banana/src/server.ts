import { FILE_READ_CAPABILITIES } from './file-read-context.js';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerGenerateTools,
  registerEditTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'nano-banana-mcp-server',
    version: pkg.version,
  }, { capabilities: FILE_READ_CAPABILITIES });

  registerConfigureTools(server);
  registerGenerateTools(server);
  registerEditTools(server);

  return server;
}
