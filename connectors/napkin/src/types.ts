/**
 * Default timeout (ms) for outbound HTTP requests (API + bridge + download).
 *
 * Napkin generation is async — create/status are polling calls that should
 * complete in <5s. Downloads can be larger, but 60s gives ample headroom
 * for a single signed-URL fetch. Override via `NAPKIN_REQUEST_TIMEOUT_MS`.
 */

import { z } from 'zod';

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
//
// Every external response body is validated fail-closed with these Zod
// schemas before it reaches tool code (AGENTS.md code conventions). The
// exported types are inferred from the schemas so the two can never drift.
// ---------------------------------------------------------------------------

export type OutputFormat = 'svg' | 'png' | 'ppt';
export type ColorMode = 'light' | 'dark' | 'both';
export type Orientation = 'auto' | 'horizontal' | 'vertical' | 'square';
export type TextExtractionMode = 'auto' | 'rewrite' | 'preserve';
export type SortStrategy = 'relevance' | 'random' | 'variation';

export const requestStatusSchema = z.enum(['pending', 'completed', 'failed']);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

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

export const generatedFileSchema = z.object({
  url: z.string(),
  visual_id: z.string(),
  visual_query: z.string().optional(),
  style_id: z.string(),
  width: z.number(),
  height: z.number(),
  color_mode: z.string().optional(),
});
export type GeneratedFile = z.infer<typeof generatedFileSchema>;

export const statusWarningSchema = z.object({
  message: z.string(),
  code: z.string(),
});
export type StatusWarning = z.infer<typeof statusWarningSchema>;
export type StatusError = StatusWarning;

export const visualStatusResponseSchema = z.object({
  id: z.string(),
  status: requestStatusSchema,
  request: z.record(z.unknown()).optional(),
  generated_files: z.array(generatedFileSchema).optional(),
  warnings: z.array(statusWarningSchema).optional(),
  error: statusWarningSchema.optional(),
  credits: z.object({ consumed: z.number() }).optional(),
});
export type VisualStatusResponse = z.infer<typeof visualStatusResponseSchema>;

export const createVisualResponseSchema = z.object({
  id: z.string(),
  status: requestStatusSchema,
  request: z.record(z.unknown()).optional(),
});
export type CreateVisualResponse = z.infer<typeof createVisualResponseSchema>;

export const FORMAT_EXTENSIONS: Record<string, string> = {
  svg: '.svg',
  png: '.png',
  ppt: '.pptx',
};
