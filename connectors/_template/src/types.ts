export const REQUEST_TIMEOUT_MS = 30_000;

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
