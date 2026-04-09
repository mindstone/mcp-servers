export const REQUEST_TIMEOUT_MS = 30_000;

export interface BridgeState {
  port: number;
  token: string;
}

export class NanoBananaError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'NanoBananaError';
  }
}

// ---------------------------------------------------------------------------
// Gemini API types
// ---------------------------------------------------------------------------

export const SUPPORTED_MODELS = [
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image',
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const DEFAULT_MODEL: SupportedModel = 'gemini-3.1-flash-image-preview';

export const SUPPORTED_ASPECT_RATIOS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
] as const;

export type SupportedAspectRatio = (typeof SUPPORTED_ASPECT_RATIOS)[number];

export interface GeminiApiErrorData {
  error?: {
    message?: string;
  };
}

export interface GeminiInlineData {
  data: string;
  mimeType?: string;
}

export interface GeminiPart {
  inlineData?: GeminiInlineData;
  text?: string;
}

export interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
  };
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
  };
}

export interface ImageConfig {
  aspectRatio: string;
}

export interface GenerationConfig {
  responseModalities: string[];
  imageConfig?: ImageConfig;
}

export const SUPPORTED_IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * Resolve an error status code to an actionable resolution string.
 */
export function getErrorResolution(status: number, detail?: string): string {
  const msg = (detail || '').toLowerCase();
  if (status === 401 || status === 403 || msg.includes('invalid') || msg.includes('unauthorized')) {
    return 'Invalid Gemini API key. Check your key at https://aistudio.google.com/api-keys';
  }
  if (status === 429) {
    return 'Rate limit exceeded. Wait a moment and try again.';
  }
  if (msg.includes('safety') || msg.includes('blocked')) {
    return 'Content was blocked by safety filters. Try a different prompt.';
  }
  return 'Please try again. If the issue persists, check your API key at https://aistudio.google.com/api-keys';
}
