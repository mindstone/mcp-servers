import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const REQUEST_TIMEOUT_MS = 30_000;
export const USER_AGENT = `mcp-server-quickbooks/${pkg.version}`;

/**
 * QuickBooks minor version sent on data-service requests. Centralised so it
 * can be bumped in one place (minorversion=65 was previously hardcoded at
 * every call site).
 */
export const QBO_MINOR_VERSION = '75';

export const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

export interface BridgeState {
  port: number;
  token: string;
}

export class QuickBooksError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'QuickBooksError';
  }
}
