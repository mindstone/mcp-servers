import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerAgentTools,
  registerConversationTools,
  registerPhoneNumberTools,
  registerKnowledgeBaseTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'elevenlabs-agents-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerAgentTools(server);
  registerConversationTools(server);
  registerPhoneNumberTools(server);
  registerKnowledgeBaseTools(server);

  return server;
}
