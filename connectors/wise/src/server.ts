import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerProfileTools,
  registerBalanceTools,
  registerActivityTools,
  registerRateTools,
  registerRecipientTools,
  registerQuoteTools,
  registerTransferTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'wise-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerProfileTools(server);
  registerBalanceTools(server);
  registerActivityTools(server);
  registerRateTools(server);
  registerRecipientTools(server);
  registerQuoteTools(server);
  registerTransferTools(server);

  return server;
}
