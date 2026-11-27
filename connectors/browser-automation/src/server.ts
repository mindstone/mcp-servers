import { FILE_READ_CAPABILITIES } from './file-read-context.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { KEEP_ALIVE_CAPABILITY, SERVER_NAME, SERVER_VERSION } from './types.js';
import { errorResult } from './utils.js';
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
      capabilities: { experimental: { ...FILE_READ_CAPABILITIES.experimental, [KEEP_ALIVE_CAPABILITY]: {} } },
    },
  );

  // The SDK turns an error raised outside a tool's handler, such as arguments
  // that fail the input schema, into a plain-text result, and its message
  // repeats the arguments, which can carry page text. Every tool's own errors
  // already go through errorResult; this sends the SDK's through it too, so
  // that text reaches the model inside an untrusted-content envelope.
  // createToolError is private in the SDK's types; test/sdk-errors.test.ts
  // fails if the SDK stops using it.
  (server as unknown as { createToolError: (message: string) => CallToolResult }).createToolError =
    (message) => errorResult(new Error(message));

  registerNavigationTools(server);
  registerInteractionTools(server);
  registerObservationTools(server);
  registerSessionTools(server);
  registerFileTools(server);

  return server;
}
