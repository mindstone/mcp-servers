import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import { COMPOSE_MESSAGE_RESOURCE_URI, registerTeamsTools } from './tools.js';
import { COMPOSE_MESSAGE_HTML } from './resources/compose-message-template.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerTeamsTools(server);
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
