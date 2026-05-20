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

/**
 * ElevenLabs music composition section.
 *
 * Field names match the live ElevenLabs API exactly. The previous version of
 * this connector (≤0.2.2) shipped a `{ style, lyrics, duration_ms }` shape
 * that the API rejects with HTTP 422; see planning doc
 * `docs/plans/260520_elevenlabs_oss_connector_fix.md` in MindstoneRebel for
 * the live-capture trace.
 */
export interface CompositionSection {
  section_name: string;
  duration_ms: number;
  positive_local_styles?: string[];
  negative_local_styles?: string[];
  /** Lyric lines for the section. Empty array (or omit) for instrumental sections. */
  lines?: string[];
}

export interface CompositionPlan {
  positive_global_styles?: string[];
  negative_global_styles?: string[];
  sections: CompositionSection[];
}

export interface MusicPlanResponse extends CompositionPlan {
  sections: CompositionSection[];
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
