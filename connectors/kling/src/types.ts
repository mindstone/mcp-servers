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
 * Kling API response wrapper.
 * All responses return code 0 for success.
 */
export interface KlingApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface VideoGenerationResponse {
  task_id: string;
}

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

export type KlingTaskStatus = 'submitted' | 'processing' | 'succeed' | 'failed';

export interface TaskStatusResponse {
  task_id: string;
  task_status: KlingTaskStatus;
  task_status_msg?: string;
  task_result?: {
    videos?: Array<{
      id?: string;
      url: string;
      duration: string;
      aspect_ratio?: string;
    }>;
    images?: Array<{
      url: string;
      index?: number;
    }>;
  };
}

/**
 * One entry of a Query Task (List) response. `task_info` (which echoes the
 * caller's prompt) is deliberately not modelled — the connector only
 * surfaces IDs, status, and result URLs.
 */
export interface TaskListItem {
  task_id: string;
  task_status: KlingTaskStatus;
  task_status_msg?: string;
  created_at?: number;
  updated_at?: number;
  task_result?: TaskStatusResponse['task_result'];
}

export interface ResourcePackInfo {
  resource_pack_name?: string;
  resource_pack_id?: string;
  resource_pack_type?: string;
  total_quantity?: number;
  remaining_quantity?: number;
  purchase_time?: number;
  effective_time?: number;
  invalid_time?: number;
  status?: string;
}

export interface AccountCostsResponse {
  code?: number;
  msg?: string;
  resource_pack_subscribe_infos?: ResourcePackInfo[];
}
