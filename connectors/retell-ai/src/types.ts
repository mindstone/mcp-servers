export const REQUEST_TIMEOUT_MS = 30_000;
export const RETELL_API_BASE = 'https://api.retellai.com';
export const SERVER_NAME = 'retell-ai-mcp-server';
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
