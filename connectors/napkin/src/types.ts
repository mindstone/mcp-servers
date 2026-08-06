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

/**
 * Machine identifiers (request IDs, error/warning codes, visual/style IDs,
 * color mode) are relayed RAW in tool output — no `<untrusted-content>`
 * envelope — so tool output stays directly usable. That carve-out is only
 * safe because this schema enforces it: bounded length and a charset with no
 * whitespace or markup, so the value can never smuggle an envelope close tag
 * or prose into model-visible output. A violation fails closed as
 * INVALID_RESPONSE upstream in client.ts.
 */
export const machineIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

/**
 * File URLs are likewise relayed raw (the model must be able to pass them
 * back to napkin_download_visual). HTTPS-only with no whitespace, quotes, or
 * angle brackets — enough to make an envelope-breakout or markup payload
 * unrepresentable.
 */
export const fileUrlSchema = z.string().regex(/^https:\/\/[^\s<>"']{1,2048}$/);

export const generatedFileSchema = z.object({
  url: fileUrlSchema,
  visual_id: machineIdSchema,
  // Natural-language free text — enveloped at relay time in generation.ts,
  // not constrained here (legitimate values can contain spaces).
  visual_query: z.string().optional(),
  style_id: machineIdSchema,
  width: z.number(),
  height: z.number(),
  color_mode: machineIdSchema.optional(),
});
export type GeneratedFile = z.infer<typeof generatedFileSchema>;

export const statusWarningSchema = z.object({
  message: z.string(),
  code: machineIdSchema,
});
export type StatusWarning = z.infer<typeof statusWarningSchema>;
export type StatusError = StatusWarning;

export const visualStatusResponseSchema = z.object({
  id: machineIdSchema,
  status: requestStatusSchema,
  request: z.record(z.unknown()).optional(),
  generated_files: z.array(generatedFileSchema).optional(),
  warnings: z.array(statusWarningSchema).optional(),
  error: statusWarningSchema.optional(),
  credits: z.object({ consumed: z.number() }).optional(),
});
export type VisualStatusResponse = z.infer<typeof visualStatusResponseSchema>;

export const createVisualResponseSchema = z.object({
  id: machineIdSchema,
  status: requestStatusSchema,
  request: z.record(z.unknown()).optional(),
});
export type CreateVisualResponse = z.infer<typeof createVisualResponseSchema>;

export const FORMAT_EXTENSIONS: Record<string, string> = {
  svg: '.svg',
  png: '.png',
  ppt: '.pptx',
};
