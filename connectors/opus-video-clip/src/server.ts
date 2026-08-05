import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'opus-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerBrandTemplateTools(server);
  registerProjectTools(server);
  registerUploadTools(server);
  registerCensorTools(server);
  registerCollectionTools(server);
  registerCollectionContentTools(server);
  registerDownloadTools(server);
  registerSocialPostingTools(server);

  return server;
}
