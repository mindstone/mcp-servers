import { FILE_READ_CAPABILITIES } from './file-read-context.js';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { filterTransport } from './key-filter.js';
import {
  registerConfigureTools,
  registerVideoTools,
  registerImageTools,
  registerAudioTools,
  registerVoiceTools,
  registerTaskTools,
  registerAccountTools,
  registerUpscaleTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/**
 * Every transport this server connects to is wrapped by `filterTransport`
 * first, so whoever creates the transport (stdio in index.ts, the in-memory
 * pair in tests) gets the same output boundary.
 */
class RunwayMcpServer extends McpServer {
  override async connect(transport: Transport): Promise<void> {
    await super.connect(filterTransport(transport));
  }
}

export function createServer(): McpServer {
  const server = new RunwayMcpServer({
    name: 'runway-mcp-server',
    version: pkg.version,
  }, { capabilities: FILE_READ_CAPABILITIES });

  registerConfigureTools(server);
  registerVideoTools(server);
  registerImageTools(server);
  registerAudioTools(server);
  registerVoiceTools(server);
  registerTaskTools(server);
  registerAccountTools(server);
  registerUpscaleTools(server);

  return server;
}
