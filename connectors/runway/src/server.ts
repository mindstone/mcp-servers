import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'runway-mcp-server',
    version: pkg.version,
  });

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
