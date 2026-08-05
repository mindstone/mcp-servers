import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const REQUEST_TIMEOUT_MS = 30_000;
export const SERVER_NAME = 'salesforce-mcp-server';
/**
 * Salesforce REST API version the connector pins every request to. Pinned
 * deliberately rather than riding jsforce's bundled default (v50.0): v66.0 is
 * Spring '26 — one release behind current (v67.0, Summer '26) so orgs still on
 * the previous release accept it. Raise this deliberately, with tests run,
 * when newer API behavior is needed.
 */
export const SALESFORCE_API_VERSION = '66.0';
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

export interface SalesforceTokenData {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  token_type?: string;
  issued_at?: string;
  id?: string;
  username?: string;
  organization_id?: string;
  expires_at?: number;
  signature?: string;
  login_url?: string;
}

export interface SalesforceAccount {
  id: string;
  username: string;
  instance_url: string;
  is_sandbox: boolean;
  connected_at: string;
}

export interface SalesforceAccountsConfig {
  accounts: SalesforceAccount[];
}

export interface SaveResult {
  success: boolean;
  id?: string;
  errors?: unknown[];
}
