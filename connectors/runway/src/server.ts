import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerVideoTools,
  registerImageTools,
  registerAudioTools,
  registerVoiceTools,
  registerTaskTools,
  registerAccountTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'runway-mcp-server',
    version: '0.3.0',
  });

  registerConfigureTools(server);
  registerVideoTools(server);
  registerImageTools(server);
  registerAudioTools(server);
  registerVoiceTools(server);
  registerTaskTools(server);
  registerAccountTools(server);

  return server;
}
