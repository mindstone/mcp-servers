import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const REQUEST_TIMEOUT_MS = 30_000;
/** Upper bound on vendor-authored error text included in error messages. */
export const MAX_VENDOR_ERROR_CHARS = 500;
export const OUTREACH_API_BASE = 'https://api.outreach.io/api/v2';
export const OUTREACH_OAUTH_URL = 'https://api.outreach.io/oauth/token';
export const OUTREACH_AUTHORIZE_URL = 'https://api.outreach.io/oauth/authorize';
export const SERVER_NAME = 'outreach-mcp-server';
/** Server version reported on MCP `initialize`. Read from package.json so
 *  it cannot drift from the published npm version. */
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

export type AuthMode = 'bridge' | 'standalone_oauth' | 'manual_token' | 'unconfigured';

export interface OutreachTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  created_at: number;
  username?: string;
}

export interface OutreachAccount {
  id: string;
  username: string;
  connected_at: string;
}

export interface OutreachAccountsConfig {
  accounts: OutreachAccount[];
}

export interface JsonApiResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, {
    data: { id: string; type: string } | { id: string; type: string }[] | null;
  }>;
  links?: Record<string, string>;
}

export interface JsonApiResponse {
  data: JsonApiResource | JsonApiResource[];
  meta?: { count?: number; page?: { current?: number; total?: number } };
  links?: { next?: string; prev?: string };
}
