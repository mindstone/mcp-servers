import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './types.js';
import { registerMailTools } from './tools.js';
import { COMPOSE_EMAIL_RESOURCE_URI } from './compose.js';
import { COMPOSE_EMAIL_HTML } from './resources/compose-email-template.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerMailTools(server);
  server.registerResource(
    'compose-email',
    COMPOSE_EMAIL_RESOURCE_URI,
    { mimeType: 'text/html' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/html', text: COMPOSE_EMAIL_HTML }],
    }),
  );
  return server;
}
