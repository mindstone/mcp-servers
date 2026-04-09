export const REQUEST_TIMEOUT_MS = parseInt(process.env.TALENTLMS_REQUEST_TIMEOUT || '30000', 10);

export interface BridgeState {
  port: number;
  token: string;
}

export class TalentLMSError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'TalentLMSError';
  }
}
