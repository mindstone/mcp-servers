export const REQUEST_TIMEOUT_MS = 30_000;

export interface BridgeState {
  port: number;
  token: string;
}

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'ElevenLabsError';
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs API types
// ---------------------------------------------------------------------------

export interface VoiceResult {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  preview_url?: string;
  labels?: Record<string, string>;
}

export interface VoicesResponse {
  voices: VoiceResult[];
  has_more?: boolean;
}

export interface CompositionSection {
  style?: string;
  lyrics?: string;
  duration_ms?: number;
}

export interface CompositionPlan {
  positive_global_styles?: string[];
  negative_global_styles?: string[];
  sections?: CompositionSection[];
}

export interface MusicPlanResponse {
  positive_global_styles: string[];
  negative_global_styles: string[];
  sections: Array<{
    style: string;
    lyrics: string;
    duration_ms: number;
  }>;
}

export interface TranscriptionWord {
  text: string;
  start: number;
  end: number;
  type?: string;
}

export interface TranscriptionResponse {
  text: string;
  words?: TranscriptionWord[];
}

export interface AudioResult {
  filePath: string;
  sizeBytes: number;
}

/**
 * Resolve an error status code to an actionable resolution string.
 */
export function getErrorResolution(status: number, detail?: string): string {
  const msg = (detail || '').toLowerCase();
  if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return 'Authentication failed. Check your ElevenLabs API key in Settings. Get one at https://elevenlabs.io/app/settings/api-keys';
  }
  if (status === 403 || msg.includes('quota') || msg.includes('limit') || msg.includes('credits')) {
    return 'Insufficient credits or quota exceeded. Check usage at https://elevenlabs.io/app/usage';
  }
  if (status === 422 || msg.includes('validation')) {
    return 'Invalid request parameters. Check the input values and try again.';
  }
  if (status === 429) {
    return 'Rate limited. Wait a moment and try again.';
  }
  if (msg.includes('content') || msg.includes('policy') || msg.includes('moderation')) {
    return 'Content policy violation. Try a different prompt.';
  }
  return 'Please try again. If the issue persists, check your API key and credits at https://elevenlabs.io/app/settings/api-keys';
}
