export const REQUEST_TIMEOUT_MS = 30_000;
export const USER_AGENT = 'MindstoneRebel/1.0 (QuickBooks-MCP)';

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
