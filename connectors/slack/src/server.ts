import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import {
  registerAuthTools,
  registerChannelTools,
  registerFileTools,
  registerMessageTools,
  registerPinTools,
  registerReactionTools,
  registerThreadTools,
  registerUserTools,
  registerWorkspaceTools,
} from './tools/index.js';
import { COMPOSE_MESSAGE_RESOURCE_URI } from './tools/messages.js';
import { COMPOSE_MESSAGE_HTML } from './resources/compose-message-template.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerAuthTools(server);
  registerMessageTools(server);
  registerChannelTools(server);
  registerThreadTools(server);
  registerReactionTools(server);
  registerUserTools(server);
  registerFileTools(server);
  registerPinTools(server);
  registerWorkspaceTools(server);

  server.registerResource(
    'compose-message',
    COMPOSE_MESSAGE_RESOURCE_URI,
    { mimeType: 'text/html' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/html', text: COMPOSE_MESSAGE_HTML }],
    }),
  );

  return server;
}
