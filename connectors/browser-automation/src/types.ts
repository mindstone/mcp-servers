export const SERVER_NAME = 'browser-automation-mcp-server';
export const SERVER_VERSION = '0.1.2';

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
