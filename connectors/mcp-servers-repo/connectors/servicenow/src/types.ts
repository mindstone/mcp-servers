export const REQUEST_TIMEOUT_MS = 30_000;

export interface BridgeState {
  port: number;
  token: string;
}

export class ServiceNowError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'ServiceNowError';
  }
}

/**
 * Regex for a valid single-label ServiceNow instance name:
 * lowercase alphanumeric with optional hyphens between segments.
 */
export const SINGLE_LABEL_INSTANCE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
