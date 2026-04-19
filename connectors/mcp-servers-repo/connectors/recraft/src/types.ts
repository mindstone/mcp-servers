export const REQUEST_TIMEOUT_MS = 60_000;
export const RECRAFT_API_BASE = 'https://external.api.recraft.ai/v1';

export class RecraftError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'RecraftError';
  }
}

export interface RecraftGeneratedImage {
  id?: string;
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
  type?: string;
}

export interface RecraftGenerationResponse {
  data?: RecraftGeneratedImage[];
  image?: RecraftGeneratedImage;
  [key: string]: unknown;
}

export interface RecraftUserInfo {
  id: string;
  email: string;
  name: string;
  credits: number;
}
