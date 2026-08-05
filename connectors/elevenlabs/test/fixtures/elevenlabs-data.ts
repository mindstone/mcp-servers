/**
 * Test fixtures for the ElevenLabs connector.
 */

export const MOCK_API_KEY = 'mcp-test-elevenlabs-key';

export const mockVoices = [
  {
    voice_id: 'voice-rachel-001',
    name: 'Rachel',
    category: 'premade',
    description: 'A calm and clear voice',
    labels: { accent: 'american', gender: 'female' },
    preview_url: 'https://api.elevenlabs.io/v1/voices/voice-rachel-001/preview',
  },
  {
    voice_id: 'voice-adam-002',
    name: 'Adam',
    category: 'premade',
    description: 'A deep and resonant voice',
    labels: { accent: 'american', gender: 'male' },
    preview_url: 'https://api.elevenlabs.io/v1/voices/voice-adam-002/preview',
  },
];

export const mockSubscription = {
  tier: 'starter',
  status: 'active',
  character_count: 12_500,
  character_limit: 30_000,
  next_character_count_reset_unix: 1_735_689_600,
  voice_slots_used: 2,
  voice_limit: 10,
};

export const mockModels = [
  {
    model_id: 'eleven_v3',
    name: 'Eleven v3',
    can_do_text_to_speech: true,
    can_do_voice_conversion: false,
    can_be_finetuned: false,
    token_cost_factor: 1,
    languages: [
      { language_id: 'en', name: 'English' },
      { language_id: 'es', name: 'Spanish' },
    ],
  },
  {
    model_id: 'eleven_multilingual_v2',
    name: 'Eleven Multilingual v2',
    can_do_text_to_speech: true,
    can_do_voice_conversion: true,
    can_be_finetuned: false,
    token_cost_factor: 1,
    languages: [{ language_id: 'en', name: 'English' }],
  },
];

export const mockSharedVoices = [
  {
    voice_id: 'shared-narrator-001',
    name: 'British Narrator',
    description: 'Warm British male narrator for documentaries',
    category: 'professional',
    gender: 'male',
    age: 'middle_aged',
    accent: 'british',
    language: 'en',
    locale: 'en-GB',
    descriptive: 'calm',
    use_case: 'narration',
    preview_url: 'https://api.elevenlabs.io/v1/voices/shared-narrator-001/preview',
    labels: { style: 'documentary' },
  },
];

export const mockVoiceDetail = {
  voice_id: 'voice-rachel-001',
  name: 'Rachel',
  category: 'premade',
  description: 'A calm and clear voice with American accent',
  labels: { accent: 'american', gender: 'female', use_case: 'narration' },
  preview_url: 'https://api.elevenlabs.io/v1/voices/voice-rachel-001/preview',
};

export const mockMusicPlan = {
  positive_global_styles: ['upbeat', 'jazz'],
  negative_global_styles: ['aggressive'],
  sections: [
    {
      section_name: 'Intro',
      duration_ms: 10000,
      positive_local_styles: ['soft piano', 'gentle pads'],
      negative_local_styles: ['drums', 'distortion'],
      lines: [],
    },
    {
      section_name: 'Chorus',
      duration_ms: 20000,
      positive_local_styles: ['full band', 'energetic vocals'],
      negative_local_styles: ['quiet', 'sparse'],
      lines: ['Here comes the sun', 'And I say, it\'s all right'],
    },
  ],
};

export const mockTranscription = {
  text: 'Hello, this is a test transcription.',
  words: [
    { text: 'Hello,', start: 0.0, end: 0.5, type: 'word' },
    { text: 'this', start: 0.6, end: 0.8, type: 'word' },
    { text: 'is', start: 0.9, end: 1.0, type: 'word' },
    { text: 'a', start: 1.1, end: 1.2, type: 'word' },
    { text: 'test', start: 1.3, end: 1.5, type: 'word' },
    { text: 'transcription.', start: 1.6, end: 2.1, type: 'word' },
  ],
};

export const mockForcedAlignment = {
  words: [
    { text: 'Hi.', start: 0.0, end: 0.4 },
  ],
  loss: 0.01,
};

export const mockCloneVoice = {
  voice_id: 'cloned-voice-001',
  requires_verification: false,
};

export const mockDialogueAudioSize = 3072;

export const mockVoiceDesignPreviews = {
  previews: [
    {
      generated_voice_id: 'gen-voice-preview-001',
      audio_base_64: Buffer.from(makeFakeAudioBuffer(512)).toString('base64'),
      text: 'Hello preview.',
      media_type: 'audio/mpeg',
    },
  ],
};

export const mockCreateVoiceFromPreview = {
  voice_id: 'designed-voice-001',
};

export const mockDubbingCreate = {
  dubbing_id: 'dub-test-001',
  expected_duration_sec: 30,
};

export const mockDubbingStatusProcessing = {
  dubbing_id: 'dub-test-001',
  name: 'rebel-test-dub',
  status: 'dubbing',
  target_languages: ['es'],
};

export const mockDubbingStatusDubbed = {
  dubbing_id: 'dub-test-001',
  name: 'rebel-test-dub',
  status: 'dubbed',
  target_languages: ['es'],
};

export const mockDubbingStatusFailed = {
  dubbing_id: 'dub-failed-001',
  name: 'rebel-test-fail',
  status: 'failed',
  target_languages: ['es'],
  error_message: 'Source audio too short for dubbing',
};

export const mockDiarizedTranscription = {
  text: 'Hello there. Hi, how are you?',
  language_code: 'en',
  language_probability: 0.99,
  words: [
    { text: 'Hello', start: 0.0, end: 0.4, type: 'word', speaker_id: 'speaker_0' },
    { text: ' there.', start: 0.4, end: 0.8, type: 'word', speaker_id: 'speaker_0' },
    { text: 'Hi,', start: 1.0, end: 1.3, type: 'word', speaker_id: 'speaker_1' },
    { text: ' how', start: 1.3, end: 1.5, type: 'word', speaker_id: 'speaker_1' },
    { text: ' are', start: 1.5, end: 1.7, type: 'word', speaker_id: 'speaker_1' },
    { text: ' you?', start: 1.7, end: 2.0, type: 'word', speaker_id: 'speaker_1' },
  ],
};

export const mockHistory = {
  history: [
    {
      history_item_id: 'hist-item-001',
      date_unix: 1_754_745_600,
      character_count_change_from: 1000,
      character_count_change_to: 1042,
      content_type: 'audio/mpeg',
      request_id: 'req-001',
      voice_id: 'voice-rachel-001',
      model_id: 'eleven_v3',
      voice_name: 'Rachel',
      voice_category: 'premade',
      text: 'Welcome to the launch.',
      source: 'TTS',
    },
  ],
  has_more: false,
  last_history_item_id: 'hist-item-001',
};

export const mockWorkspaceUsage = {
  columns: ['product_type', 'timestamp', 'total_usage', 'total_minutes', 'total_cost', 'usage_count', 'total_charge_count'],
  column_types: ['String', 'DateTime', 'Int', 'Float', 'Float', 'Int', 'Float'],
  column_units: [null, null, 'credits', 'min', 'usd', null, null],
  rows: [
    ['text-to-speech', '2026-08-04T00:00:00Z', 125.5, 4.2, 0.05, 12, 0],
    ['music', '2026-08-04T00:00:00Z', 78.3, 1.1, 0.03, 3, 0],
    ['text-to-speech', '2026-08-05T00:00:00Z', 42, 1.4, 0.02, 5, 0],
  ],
};

export const mockPronunciationDictionaryList = {
  pronunciation_dictionaries: [
    {
      id: 'pd-001',
      name: 'Brand terms',
      description: 'How to say our product names',
      latest_version_id: 'pd-001-v1',
      latest_version_rules_num: 1,
      permission_on_resource: 'admin',
      created_by: 'user-001',
      creation_time_unix: 1_754_745_600,
      archived_time_unix: null,
    },
  ],
  has_more: false,
  next_cursor: null,
};

export const mockPronunciationDictionaryDetail = {
  ...mockPronunciationDictionaryList.pronunciation_dictionaries[0],
  rules: [
    {
      string_to_replace: 'Thailand',
      type: 'alias',
      alias: 'tie-land',
      case_sensitive: true,
      word_boundaries: true,
    },
  ],
};

export const mockAddPronunciationDictionary = {
  id: 'pd-002',
  name: 'Brand terms',
  created_by: 'user-001',
  creation_time_unix: 1_754_745_600,
  version_id: 'pd-002-v1',
  version_rules_num: 1,
  permission_on_resource: 'admin',
  description: null,
};

export const mockSpeechWithTimestamps = {
  audio_base64: Buffer.from(makeFakeAudioBuffer(1024)).toString('base64'),
  alignment: {
    characters: ['W', 'e', 'l', 'c', 'o', 'm', 'e', ' ', 'h', 'o', 'm', 'e', '.'],
    character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2],
    character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4],
  },
  normalized_alignment: null,
};

/**
 * Generate a fake audio buffer for testing binary output.
 */
export function makeFakeAudioBuffer(sizeBytes = 1024): Buffer {
  const buffer = Buffer.alloc(sizeBytes);
  // Write an MP3 magic header to make it slightly realistic
  buffer[0] = 0xff;
  buffer[1] = 0xfb;
  buffer[2] = 0x90;
  buffer[3] = 0x00;
  return buffer;
}
