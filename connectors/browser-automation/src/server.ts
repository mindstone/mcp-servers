import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KEEP_ALIVE_CAPABILITY, SERVER_NAME, SERVER_VERSION } from './types.js';
import {
  registerNavigationTools,
  registerInteractionTools,
  registerObservationTools,
  registerSessionTools,
  registerFileTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      // The browser this server opens must stay open between calls, so ask a
      // host that idle-stops servers (super-mcp) to keep this one running
      // until the host itself stops. It still stops it cleanly then, which is
      // when closeBrowserOnStop closes the browser.
      capabilities: { experimental: { [KEEP_ALIVE_CAPABILITY]: {} } },
    },
  );

  registerNavigationTools(server);
  registerInteractionTools(server);
  registerObservationTools(server);
  registerSessionTools(server);
  registerFileTools(server);

  return server;
}
