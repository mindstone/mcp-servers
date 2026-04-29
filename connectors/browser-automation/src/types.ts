import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const SERVER_NAME = 'browser-automation-mcp-server';
/** Server version reported on MCP `initialize`. Read from package.json so
 *  it cannot drift from the published npm version. */
export const SERVER_VERSION = pkg.version;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const SNAPSHOT_TIMEOUT_MS = 15_000;
export const SCREENSHOT_TIMEOUT_MS = 15_000;
export const SESSION_NAME = 'mcp';

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}
