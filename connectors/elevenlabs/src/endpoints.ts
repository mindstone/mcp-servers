/**
 * Canonical ElevenLabs API endpoint paths.
 *
 * Every path used by this connector lives here so a wrong path is a
 * one-line fix. v1 paths are relative to `ELEVENLABS_API_V1_BASE`; v2 voice
 * listing uses the separate v2 base URL.
 */

export const ELEVENLABS_API_V1_BASE = 'https://api.elevenlabs.io/v1';
export const ELEVENLABS_API_V2_BASE = 'https://api.elevenlabs.io/v2';

/** v1 relative paths — pass to `elevenLabsFetch` / `elevenLabsJson`. */
export const ENDPOINTS = {
  USER_SUBSCRIPTION: '/user/subscription',
  MODELS: '/models',
  SHARED_VOICES: '/shared-voices',
  SOUND_GENERATION: '/sound-generation',
  MUSIC: '/music',
  MUSIC_PLAN: '/music/plan',
  SPEECH_TO_TEXT: '/speech-to-text',
  AUDIO_ISOLATION: '/audio-isolation',
  FORCED_ALIGNMENT: '/forced-alignment',
  VOICES_ADD: '/voices/add',
  TEXT_TO_DIALOGUE: '/text-to-dialogue',
  TEXT_TO_VOICE_DESIGN: '/text-to-voice/design',
  TEXT_TO_VOICE: '/text-to-voice',
  DUBBING: '/dubbing',
  HISTORY: '/history',
  PRONUNCIATION_DICTIONARIES: '/pronunciation-dictionaries',
  PRONUNCIATION_DICTIONARIES_ADD_FROM_RULES: '/pronunciation-dictionaries/add-from-rules',
  WORKSPACE_USAGE_BY_PRODUCT: '/workspace/analytics/query/usage-by-product-over-time',
  voice: (voiceId: string) => `/voices/${encodeURIComponent(voiceId)}`,
  dubbing: (dubbingId: string) => `/dubbing/${encodeURIComponent(dubbingId)}`,
  dubbingAudio: (dubbingId: string, languageCode: string) =>
    `/dubbing/${encodeURIComponent(dubbingId)}/audio/${encodeURIComponent(languageCode)}`,
  historyAudio: (historyItemId: string) =>
    `/history/${encodeURIComponent(historyItemId)}/audio`,
  pronunciationDictionary: (dictionaryId: string) =>
    `/pronunciation-dictionaries/${encodeURIComponent(dictionaryId)}`,
  speechToSpeech: (voiceId: string) =>
    `/speech-to-speech/${encodeURIComponent(voiceId)}`,
  textToSpeech: (voiceId: string, outputFormat: string) =>
    `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
  textToSpeechWithTimestamps: (voiceId: string, outputFormat: string) =>
    `/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${encodeURIComponent(outputFormat)}`,
} as const;

/** Build a full v2 voices list/search URL with optional query string. */
export function voicesV2Url(params?: URLSearchParams): string {
  const qs = params?.toString();
  return `${ELEVENLABS_API_V2_BASE}/voices${qs ? `?${qs}` : ''}`;
}
