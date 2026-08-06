export const REQUEST_TIMEOUT_MS = 30_000;

/** Per-call override for slow synchronous endpoints (dialogue, voice design). */
export const LONG_REQUEST_TIMEOUT_MS = 120_000;

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
  /** Present when the request enabled diarize (e.g. "speaker_0"). */
  speaker_id?: string;
}

export interface PronunciationDictionaryRule {
  string_to_replace: string;
  type: 'alias' | 'phoneme';
  alias?: string;
  phoneme?: string;
  alphabet?: string;
  case_sensitive?: boolean;
  word_boundaries?: boolean;
}

export interface PronunciationDictionaryMetadata {
  id: string;
  name: string;
  description?: string | null;
  latest_version_id?: string;
  latest_version_rules_num?: number;
  version_id?: string;
  version_rules_num?: number;
  permission_on_resource?: string | null;
  created_by?: string;
  creation_time_unix?: number;
  archived_time_unix?: number | null;
}

export interface PronunciationDictionaryWithRules extends PronunciationDictionaryMetadata {
  rules?: PronunciationDictionaryRule[];
}

export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface AudioResult {
  filePath: string;
  sizeBytes: number;
}

export interface DialogueInput {
  text: string;
  voice_id: string;
}

import { envelopeApiErrorDetail } from './error-detail.js';

/** Actionable resolution when a voice_id or voice_name cannot be resolved. */
export const VOICE_NOT_FOUND_RESOLUTION =
  'Use list_voices to browse voices on this account, or search_shared_voices to find voices in the public library. Pass the exact voice_id to generate_speech.';

/**
 * Resolve an error status code to an actionable resolution string.
 */
export function getErrorResolution(status: number, detail?: string): string {
  const msg = (detail || '').toLowerCase();
  if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return 'Authentication failed. Check your ElevenLabs API key in Settings. Get one at https://elevenlabs.io/app/settings/api-keys';
  }
  if (status === 403 || msg.includes('quota') || msg.includes('limit') || msg.includes('credits')) {
    return (
      'Insufficient credits or quota exceeded. Call check_subscription to see remaining characters and the next reset date, ' +
      'or check usage at https://elevenlabs.io/app/usage'
    );
  }
  if (status === 422 || msg.includes('validation')) {
    const base = 'Invalid request parameters. Check the input values and try again.';
    if (detail) {
      return `${base} Field issues: ${envelopeApiErrorDetail(detail)}`;
    }
    return base;
  }
  if (status === 429) {
    return 'Rate limited. Wait a moment and try again.';
  }
  if (msg.includes('unsupported_content_type')) {
    return "The uploaded file type isn't supported for this operation. Provide a supported audio/video format (mp3, wav, mp4, …).";
  }
  if (
    msg.includes('content policy') ||
    msg.includes('moderation') ||
    msg.includes('flagged') ||
    msg.includes('policy violation')
  ) {
    return 'Content policy violation. Try a different prompt.';
  }
  return 'Please try again. If the issue persists, call check_subscription for credit status or check your API key at https://elevenlabs.io/app/settings/api-keys';
}
