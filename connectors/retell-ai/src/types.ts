import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const REQUEST_TIMEOUT_MS = 30_000;
export const RETELL_API_BASE = 'https://api.retellai.com';
export const SERVER_NAME = 'retell-ai-mcp-server';
/**
 * Server version reported on MCP `initialize`. Read from package.json so it
 * cannot drift from the published npm version (previously hardcoded and
 * caused 0.1.1 to be reported by 0.1.2 and 0.1.3 packages).
 */
export const SERVER_VERSION = pkg.version;

export interface BridgeState {
  port: number;
  token: string;
}

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
