import { FILE_READ_CAPABILITIES } from './file-read-context.js';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { filterTransport } from './key-filter.js';
import {
  registerConfigureTools,
  registerVideoTools,
  registerDownloadTools,
  registerExtendTools,
  registerLipSyncTools,
  registerTaskListTools,
  registerAccountTools,
  registerImageTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'kling-mcp-server',
    version: pkg.version,
  }, { capabilities: FILE_READ_CAPABILITIES });

  registerConfigureTools(server);
  registerVideoTools(server);
  registerDownloadTools(server);
  registerExtendTools(server);
  registerLipSyncTools(server);
  registerTaskListTools(server);
  registerAccountTools(server);
  registerImageTools(server);

  // Every transport this server connects to (stdio in index.ts, in-memory in
  // tests) gets the credential filter on its outgoing side, so no message the
  // SDK sends — whoever built it — can carry a credential.
  const connect = server.connect.bind(server);
  server.connect = (transport) => connect(filterTransport(transport));

  return server;
}
