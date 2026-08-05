import { z } from 'zod';

export const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

/**
 * Default timeout (ms) for outbound HTTP requests (API + bridge).
 *
 * Kling video generation is async via task_id polling, so individual
 * HTTP calls (submit + poll) should complete in <5s. The 60s default
 * gives headroom for occasional slow submits under load while still
 * surfacing real upstream outages. Override via
 * `KLING_REQUEST_TIMEOUT_MS`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Sanity ceiling on configured timeouts. 30 minutes catches accidental
 * extra zeros in env values (e.g. pasting `600000000` instead of `60000`).
 */
export const MAX_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function parseTimeoutEnv(envVarName: string, fallbackMs: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `[Kling] Ignoring invalid ${envVarName}=${JSON.stringify(raw)} (expected positive integer ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  if (parsed > MAX_REQUEST_TIMEOUT_MS) {
    console.error(
      `[Kling] Ignoring ${envVarName}=${parsed} (exceeds max ${MAX_REQUEST_TIMEOUT_MS}ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  return parsed;
}

/**
 * Timeout (ms) for outbound requests. Reads `KLING_REQUEST_TIMEOUT_MS` at
 * call time, falling back to `DEFAULT_REQUEST_TIMEOUT_MS`.
 */
export function getRequestTimeoutMs(): number {
  return parseTimeoutEnv('KLING_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
}

export interface BridgeState {
  port: number;
  token: string;
}

export class KlingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'KlingError';
  }
}

/**
 * Kling API response envelope: all responses return code 0 for success.
 * `data` is validated against a per-endpoint schema by `klingFetch` before it
 * reaches tool code (fail-closed — a malformed or shape-drifting payload
 * surfaces as a generic INVALID_RESPONSE error, never as raw vendor text).
 */
export const klingEnvelopeSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.unknown(),
});

/** Loose shape for vendor error payloads on non-OK HTTP responses. */
export const klingVendorErrorSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
});

export const taskCreatedResponseSchema = z.object({
  task_id: z.string(),
});
export type VideoGenerationResponse = z.infer<typeof taskCreatedResponseSchema>;

/**
 * Logical task types the connector knows about, mapped to their API paths.
 * Used by check_kling_task (single-task query) and list_kling_tasks (list).
 */
export const TASK_TYPE_PATHS = {
  text2video: '/videos/text2video',
  image2video: '/videos/image2video',
  'video-extend': '/videos/video-extend',
  'lip-sync': '/videos/lip-sync',
  image: '/images/generations',
} as const;

export type KlingTaskType = keyof typeof TASK_TYPE_PATHS;

export const klingTaskStatusSchema = z.enum(['submitted', 'processing', 'succeed', 'failed']);
export type KlingTaskStatus = z.infer<typeof klingTaskStatusSchema>;

const taskResultSchema = z.object({
  videos: z
    .array(
      z.object({
        id: z.string().optional(),
        url: z.string(),
        duration: z.string(),
        aspect_ratio: z.string().optional(),
      }),
    )
    .optional(),
  images: z
    .array(
      z.object({
        url: z.string(),
        index: z.number().optional(),
      }),
    )
    .optional(),
});

export const taskStatusResponseSchema = z.object({
  task_id: z.string(),
  task_status: klingTaskStatusSchema,
  task_status_msg: z.string().optional(),
  task_result: taskResultSchema.optional(),
});
export type TaskStatusResponse = z.infer<typeof taskStatusResponseSchema>;

/**
 * One entry of a Query Task (List) response. `task_info` (which echoes the
 * caller's prompt) is deliberately not modelled — the connector only
 * surfaces IDs, status, and result URLs.
 */
export const taskListItemSchema = taskStatusResponseSchema.extend({
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
});
export const taskListResponseSchema = z.array(taskListItemSchema);
export type TaskListItem = z.infer<typeof taskListItemSchema>;

export const accountCostsResponseSchema = z.object({
  code: z.number().optional(),
  msg: z.string().optional(),
  resource_pack_subscribe_infos: z
    .array(
      z.object({
        resource_pack_name: z.string().optional(),
        resource_pack_id: z.string().optional(),
        resource_pack_type: z.string().optional(),
        total_quantity: z.number().optional(),
        remaining_quantity: z.number().optional(),
        purchase_time: z.number().optional(),
        effective_time: z.number().optional(),
        invalid_time: z.number().optional(),
        status: z.string().optional(),
      }),
    )
    .optional(),
});
export type AccountCostsResponse = z.infer<typeof accountCostsResponseSchema>;
