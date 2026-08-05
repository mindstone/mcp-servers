import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerAccountTools,
  registerMusicTools,
  registerSpeechTools,
  registerVoiceTools,
  registerTranscriptionTools,
  registerVoiceChangerTools,
  registerAudioIsolationTools,
  registerAlignmentTools,
  registerVoiceCloneTools,
  registerDialogueTools,
  registerVoiceDesignTools,
  registerDubbingTools,
  registerHistoryTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'elevenlabs-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerAccountTools(server);
  registerMusicTools(server);
  registerSpeechTools(server);
  registerVoiceTools(server);
  registerTranscriptionTools(server);
  registerVoiceChangerTools(server);
  registerAudioIsolationTools(server);
  registerAlignmentTools(server);
  registerVoiceCloneTools(server);
  registerDialogueTools(server);
  registerVoiceDesignTools(server);
  registerDubbingTools(server);
  registerHistoryTools(server);

  return server;
}
