import { FILE_READ_CAPABILITIES } from './file-read-context.js';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { filterTransport } from './key-filter.js';
import {
  registerConfigureTools,
  registerBrandTemplateTools,
  registerProjectTools,
  registerUploadTools,
  registerCensorTools,
  registerCollectionTools,
  registerCollectionContentTools,
  registerDownloadTools,
  registerSocialPostingTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/**
 * Make every transport this server connects to filter credentials out of
 * every outgoing message. Done on `connect` itself, so every caller (stdio in
 * `index.ts`, in-memory test clients) gets it without wiring its own.
 */
export function withCredentialFilter(server: McpServer): McpServer {
  const connect = server.connect.bind(server);
  server.connect = (transport) => connect(filterTransport(transport));
  return server;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'opus-mcp-server',
    version: pkg.version,
  }, { capabilities: FILE_READ_CAPABILITIES });

  registerConfigureTools(server);
  registerBrandTemplateTools(server);
  registerProjectTools(server);
  registerUploadTools(server);
  registerCensorTools(server);
  registerCollectionTools(server);
  registerCollectionContentTools(server);
  registerDownloadTools(server);
  registerSocialPostingTools(server);

  return withCredentialFilter(server);
}
