/**
 * Default timeout (ms) for outbound HTTP requests (API + bridge + download).
 *
 * Napkin generation is async — create/status are polling calls that should
 * complete in <5s. Downloads can be larger, but 60s gives ample headroom
 * for a single signed-URL fetch. Override via `NAPKIN_REQUEST_TIMEOUT_MS`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Sanity ceiling on configured timeouts. 30 minutes catches accidental
 * extra zeros in env values.
 */
export const MAX_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function parseTimeoutEnv(envVarName: string, fallbackMs: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `[Napkin] Ignoring invalid ${envVarName}=${JSON.stringify(raw)} (expected positive integer ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  if (parsed > MAX_REQUEST_TIMEOUT_MS) {
    console.error(
      `[Napkin] Ignoring ${envVarName}=${parsed} (exceeds max ${MAX_REQUEST_TIMEOUT_MS}ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  return parsed;
}

/**
 * Timeout (ms) for outbound requests. Reads `NAPKIN_REQUEST_TIMEOUT_MS`
 * at call time, falling back to `DEFAULT_REQUEST_TIMEOUT_MS`.
 */
export function getRequestTimeoutMs(): number {
  return parseTimeoutEnv('NAPKIN_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
}

export interface BridgeState {
  port: number;
  token: string;
}

export class NapkinError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'NapkinError';
  }
}

// ---------------------------------------------------------------------------
// Napkin API types
// ---------------------------------------------------------------------------

export type OutputFormat = 'svg' | 'png' | 'ppt';
export type ColorMode = 'light' | 'dark' | 'both';
export type Orientation = 'auto' | 'horizontal' | 'vertical' | 'square';
export type TextExtractionMode = 'auto' | 'rewrite' | 'preserve';
export type SortStrategy = 'relevance' | 'random' | 'variation';
export type RequestStatus = 'pending' | 'completed' | 'failed';

export interface VisualRequest {
  content: string;
  format?: OutputFormat;
  language?: string;
  context?: string;
  style_id?: string;
  visual_query?: string;
  visual_queries?: string[];
  visual_id?: string;
  visual_ids?: string[];
  transparent_background?: boolean;
  color_mode?: ColorMode;
  number_of_visuals?: number;
  orientation?: Orientation;
  text_extraction_mode?: TextExtractionMode;
  sort_strategy?: SortStrategy;
  width?: number;
  height?: number;
}

export interface GeneratedFile {
  url: string;
  visual_id: string;
  visual_query?: string;
  style_id: string;
  width: number;
  height: number;
  color_mode?: string;
}

export interface StatusWarning {
  message: string;
  code: string;
}

export interface StatusError {
  message: string;
  code: string;
}

export interface VisualStatusResponse {
  id: string;
  status: RequestStatus;
  request?: Record<string, unknown>;
  generated_files?: GeneratedFile[];
  warnings?: StatusWarning[];
  error?: StatusError;
  credits?: { consumed: number };
}

export interface CreateVisualResponse {
  id: string;
  status: RequestStatus;
  request?: Record<string, unknown>;
}

export const FORMAT_EXTENSIONS: Record<string, string> = {
  svg: '.svg',
  png: '.png',
  ppt: '.pptx',
};
