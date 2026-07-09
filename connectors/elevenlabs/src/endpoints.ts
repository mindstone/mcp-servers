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
  voice: (voiceId: string) => `/voices/${encodeURIComponent(voiceId)}`,
  textToSpeech: (voiceId: string, outputFormat: string) =>
    `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
} as const;

/** Build a full v2 voices list/search URL with optional query string. */
export function voicesV2Url(params?: URLSearchParams): string {
  const qs = params?.toString();
  return `${ELEVENLABS_API_V2_BASE}/voices${qs ? `?${qs}` : ''}`;
}
