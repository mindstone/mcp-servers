import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerMusicTools,
  registerSpeechTools,
  registerVoiceTools,
  registerTranscriptionTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'elevenlabs-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerMusicTools(server);
  registerSpeechTools(server);
  registerVoiceTools(server);
  registerTranscriptionTools(server);

  return server;
}
