export const REQUEST_TIMEOUT_MS = 30_000;
export const SERVER_NAME = 'salesforce-mcp-server';
export const SERVER_VERSION = '0.1.0';

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
