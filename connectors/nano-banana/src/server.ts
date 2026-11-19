import { FILE_READ_CAPABILITIES } from './file-read-context.js';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerGenerateTools,
  registerEditTools,
} from './tools/index.js';
import { filterTransport } from './key-filter.js';
import { unexpectedErrorResult } from './utils.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'nano-banana-mcp-server',
    version: pkg.version,
  }, { capabilities: FILE_READ_CAPABILITIES });

  filterEveryOutgoingMessage(server);
  returnFixedTextForThrows(server);
  registerConfigureTools(server);
  registerGenerateTools(server);
  registerEditTools(server);

  return server;
}

/**
 * The one choke point for output: every transport the server connects to
 * (stdio in `index.ts`, in-memory in tests) has its `send` wrapped first, and
 * the SDK sends every message (tool results, the errors it builds itself for
 * invalid arguments or an unknown tool, notifications) through it. So no API
 * key this process has held reaches the client, at any depth.
 */
function filterEveryOutgoingMessage(server: McpServer): void {
  const connect = server.connect.bind(server);
  server.connect = (transport) => connect(filterTransport(transport));
}

type AnyToolCallback = (...args: unknown[]) => unknown;

/**
 * A tool callback that throws gets the fixed unexpected-error result, so the
 * SDK never turns raw error text into a result. Every tool is registered
 * through `server.registerTool`.
 */
function returnFixedTextForThrows(server: McpServer): void {
  const register = server.registerTool.bind(server);
  const registerGuarded = (name: string, config: unknown, callback: AnyToolCallback) => {
    const guarded: AnyToolCallback = async (...args) => {
      try {
        return await callback(...args);
      } catch (error) {
        return unexpectedErrorResult(error);
      }
    };
    return register(name, config as never, guarded as never);
  };
  server.registerTool = registerGuarded as typeof server.registerTool;
}
