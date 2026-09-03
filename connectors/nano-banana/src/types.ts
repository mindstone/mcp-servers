/**
 * Default timeouts (ms) for outbound HTTP requests.
 *
 * Gemini image generation — especially `gemini-3-pro-image-preview` — can
 * legitimately take 60-120s per request. We default to 180_000 (3 min) so
 * Pro-quality generations don't spuriously abort. Users can override via
 * `NANO_BANANA_GEMINI_TIMEOUT_MS` if their infra needs a tighter bound.
 *
 * Bridge requests are local HTTP calls to the host app and should be fast;
 * 30s is a generous ceiling. Override via `NANO_BANANA_BRIDGE_TIMEOUT_MS`.
 */
export const DEFAULT_GEMINI_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sanity ceiling on configured timeouts. 30 minutes is well above any
 * realistic image-gen latency and catches accidental extra zeros in env
 * values (e.g. pasting `1800000000` instead of `180000`).
 */
export const MAX_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Parse a positive integer from an env var. Returns the fallback (with a
 * stderr warning) for missing/empty, non-integer, non-positive, or
 * out-of-range values so misconfiguration is visible rather than silently
 * defaulting.
 */
function parseTimeoutEnv(envVarName: string, fallbackMs: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `[NanoBanana] Ignoring invalid ${envVarName}=${JSON.stringify(raw)} (expected positive integer ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  if (parsed > MAX_REQUEST_TIMEOUT_MS) {
    console.error(
      `[NanoBanana] Ignoring ${envVarName}=${parsed} (exceeds max ${MAX_REQUEST_TIMEOUT_MS}ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  return parsed;
}

/**
 * Timeout (ms) for outbound Gemini API requests. Reads
 * `NANO_BANANA_GEMINI_TIMEOUT_MS` at call time, falling back to
 * `DEFAULT_GEMINI_REQUEST_TIMEOUT_MS`.
 */
export function getGeminiRequestTimeoutMs(): number {
  return parseTimeoutEnv('NANO_BANANA_GEMINI_TIMEOUT_MS', DEFAULT_GEMINI_REQUEST_TIMEOUT_MS);
}

/**
 * Timeout (ms) for outbound host bridge requests. Reads
 * `NANO_BANANA_BRIDGE_TIMEOUT_MS` at call time, falling back to
 * `DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS`.
 */
export function getBridgeRequestTimeoutMs(): number {
  return parseTimeoutEnv('NANO_BANANA_BRIDGE_TIMEOUT_MS', DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS);
}

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

export const SUPPORTED_IMAGE_SIZES = ['1K', '2K', '4K'] as const;

export type SupportedImageSize = (typeof SUPPORTED_IMAGE_SIZES)[number];

/**
 * The legacy model ignores/rejects `imageConfig.imageSize` — it always
 * produces ~1K output. Callers must refuse an explicit image_size for it
 * rather than silently shipping a request the API cannot honour.
 */
export function supportsImageSize(model: SupportedModel): boolean {
  return model !== 'gemini-2.5-flash-image';
}

/**
 * Structured refusal for an image_size the chosen model cannot honour.
 * Shared by generate/edit so both tools emit the identical contract.
 */
export function unsupportedImageSizePayload(model: SupportedModel, imageSize: string) {
  return {
    ok: false as const,
    error: `image_size "${imageSize}" is not supported by ${model} — that model always produces ~1K output.`,
    code: 'UNSUPPORTED_IMAGE_SIZE',
    resolution:
      'Use "gemini-3.1-flash-image-preview" or "gemini-3-pro-image-preview" for 2K/4K output, or omit image_size.',
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
  aspectRatio?: string;
  imageSize?: string;
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
 * MIME types this connector will put into an MCP image content part or use
 * to pick a save extension. `inlineData.mimeType` is external,
 * vendor-controlled text, so response bytes are sniffed before this declared
 * subset is applied. Unsupported bytes are rejected rather than relabelled or
 * forwarded into model-visible output.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function sniffImageMimeType(base64Data: string): string | null {
  // Only the first 12 decoded bytes are needed for the supported signatures.
  // Decode a bounded prefix so MIME validation does not duplicate the full
  // image allocation before the caller returns or saves the original base64.
  const header = Buffer.from(base64Data.slice(0, 24), 'base64');
  if (
    header.length >= 8
    && header[0] === 0x89
    && header[1] === 0x50
    && header[2] === 0x4e
    && header[3] === 0x47
    && header[4] === 0x0d
    && header[5] === 0x0a
    && header[6] === 0x1a
    && header[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    header.length >= 6
    && header[0] === 0x47
    && header[1] === 0x49
    && header[2] === 0x46
    && header[3] === 0x38
    && (header[4] === 0x37 || header[4] === 0x39)
    && header[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    header.length >= 12
    && header.toString('ascii', 0, 4) === 'RIFF'
    && header.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function normaliseImageMimeType(
  mimeType: string | undefined,
  base64Data: string,
): string {
  const sniffedMimeType = sniffImageMimeType(base64Data);
  if (sniffedMimeType && ALLOWED_IMAGE_MIME_TYPES.has(sniffedMimeType)) {
    if (mimeType !== sniffedMimeType) {
      console.error('[NanoBanana] Ignoring untrusted response MIME; using byte-sniffed image format');
    }
    return sniffedMimeType;
  }

  throw new NanoBananaError(
    'Gemini returned image bytes in an unsupported or unrecognised format.',
    'UNSUPPORTED_IMAGE_FORMAT',
    'Try generating the image again. This connector supports PNG, JPEG, and WebP output.',
  );
}

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
