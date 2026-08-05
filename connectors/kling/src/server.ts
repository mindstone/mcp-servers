import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerVideoTools,
  registerDownloadTools,
  registerExtendTools,
  registerLipSyncTools,
  registerTaskListTools,
  registerAccountTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'kling-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerVideoTools(server);
  registerDownloadTools(server);
  registerExtendTools(server);
  registerLipSyncTools(server);
  registerTaskListTools(server);
  registerAccountTools(server);

  return server;
}
