export const REQUEST_TIMEOUT_MS = 30_000;

export const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1';
export const RUNWAY_API_VERSION = '2024-11-06';

export interface BridgeState {
  port: number;
  token: string;
}

export class RunwayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'RunwayError';
  }
}

// ---------------------------------------------------------------------------
// Runway API types
// ---------------------------------------------------------------------------

export interface TaskResponse {
  id: string;
}

export interface TaskDetail {
  id: string;
  status: 'PENDING' | 'THROTTLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  createdAt: string;
  output?: string[];
  failure?: string;
  failureCode?: string;
}

export interface OrgResponse {
  tier: {
    maxMonthlyCreditSpend: number;
    models: Record<string, { maxConcurrentGenerations: number; maxDailyGenerations: number }>;
  };
  creditBalance: number;
  usage: { models: Record<string, { dailyGenerations: number }> };
}

export interface UsageResponse {
  results: Array<{ date: string; usedCredits: Array<{ model: string; amount: number }> }>;
  models: string[];
}

export interface VoiceItem {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  status: string;
}

export interface VoiceListResponse {
  data: VoiceItem[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface VoicePreviewResponse {
  url: string;
  durationSecs: number;
}

export interface UploadResponse {
  uploadUrl: string;
  fields: Record<string, string>;
  runwayUri: string;
}

// ---------------------------------------------------------------------------
// MIME & size limits
// ---------------------------------------------------------------------------

export const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac',
};

/** Data URI size limits (binary, before base64 expansion) */
export const DATA_URI_BINARY_LIMITS: Record<string, number> = {
  image: 3_300_000,
  video: 12_000_000,
  audio: 12_000_000,
};

export const MAX_UPLOAD_BYTES = 200 * 1_048_576;
export const MIN_UPLOAD_BYTES = 512;

// ---------------------------------------------------------------------------
// Voice presets and language constants
// ---------------------------------------------------------------------------

export const VOICE_PRESETS = [
  'Maya', 'Arjun', 'Serene', 'Bernard', 'Billy', 'Mark', 'Clint', 'Mabel',
  'Chad', 'Leslie', 'Eleanor', 'Elias', 'Elliot', 'Grungle', 'Brodie',
  'Sandra', 'Kirk', 'Kylie', 'Lara', 'Lisa', 'Malachi', 'Marlene', 'Martin',
  'Miriam', 'Monster', 'Paula', 'Pip', 'Rusty', 'Ragnar', 'Xylar', 'Maggie',
  'Jack', 'Katie', 'Noah', 'James', 'Rina', 'Ella', 'Mariah', 'Frank',
  'Claudia', 'Niki', 'Vincent', 'Kendrick', 'Myrna', 'Tom', 'Wanda',
  'Benjamin', 'Kiana', 'Rachel',
] as const;

export const DUBBING_LANGUAGES = [
  'en', 'hi', 'pt', 'zh', 'es', 'fr', 'de', 'ja', 'ar', 'ru', 'ko', 'id',
  'it', 'nl', 'tr', 'pl', 'sv', 'fil', 'ms', 'ro', 'uk', 'el', 'cs', 'da',
  'fi', 'bg', 'hr', 'sk', 'ta',
] as const;

/**
 * Resolve an error status code to an actionable resolution string.
 */
export function getErrorResolution(status: number): string {
  if (status === 401) {
    return 'Authentication failed. Check your Runway API key. Get one at https://dev.runwayml.com/';
  }
  if (status === 403) {
    return 'Access forbidden. Check your Runway API key and account permissions.';
  }
  if (status === 404) {
    return 'The resource does not exist or was deleted.';
  }
  if (status === 429) {
    return 'Rate limited. Wait a moment and try again.';
  }
  return 'Try again or check https://dev.runwayml.com/';
}
