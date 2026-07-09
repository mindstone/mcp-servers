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
