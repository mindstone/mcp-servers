import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerMusicTools,
  registerSpeechTools,
  registerVoiceTools,
  registerTranscriptionTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'elevenlabs-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerMusicTools(server);
  registerSpeechTools(server);
  registerVoiceTools(server);
  registerTranscriptionTools(server);

  return server;
}
