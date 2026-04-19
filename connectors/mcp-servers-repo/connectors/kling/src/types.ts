export const REQUEST_TIMEOUT_MS = 30_000;
export const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

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

export interface TaskStatusResponse {
  task_id: string;
  task_status: 'submitted' | 'processing' | 'succeed' | 'failed';
  task_status_msg?: string;
  task_result?: {
    videos?: Array<{
      url: string;
      duration: string;
      aspect_ratio?: string;
    }>;
  };
}
