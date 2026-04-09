/**
 * Test fixtures for Runway MCP connector.
 */

export const MOCK_API_KEY = 'key_test_mock_secret_12345';

export const mockOrgResponse = {
  tier: {
    maxMonthlyCreditSpend: 10000,
    models: {
      gen4_turbo: { maxConcurrentGenerations: 5, maxDailyGenerations: 100 },
      'gen4.5': { maxConcurrentGenerations: 3, maxDailyGenerations: 50 },
      'veo3.1': { maxConcurrentGenerations: 2, maxDailyGenerations: 50 },
    },
  },
  creditBalance: 4250,
  usage: {
    models: {
      gen4_turbo: { dailyGenerations: 3 },
    },
  },
};

export const mockUsageResponse = {
  results: [
    {
      date: '2026-03-12',
      usedCredits: [
        { model: 'gen4.5', amount: 120 },
        { model: 'gen4_turbo', amount: 25 },
      ],
    },
    {
      date: '2026-03-11',
      usedCredits: [{ model: 'gen4.5', amount: 60 }],
    },
  ],
  models: ['gen4.5', 'gen4_turbo'],
};

export const mockTaskSucceeded = {
  id: 'task-abc-123',
  status: 'SUCCEEDED',
  createdAt: '2026-02-01T10:00:00Z',
  output: ['https://runway-output.example.com/video.mp4'],
};

export const mockTaskFailed = {
  id: 'task-fail-456',
  status: 'FAILED',
  createdAt: '2026-02-01T10:00:00Z',
  failure: 'Content moderation rejected the input.',
  failureCode: 'MODERATION_REJECTED',
};

export const mockTaskPending = {
  id: 'task-pending-789',
  status: 'PENDING',
  createdAt: '2026-02-01T10:00:00Z',
};

export const mockVoiceList = {
  data: [
    {
      id: 'voice-001',
      name: 'Corporate Narrator',
      description: 'Warm and professional',
      createdAt: '2026-03-10T10:00:00Z',
      status: 'READY',
    },
  ],
  hasMore: false,
};

export const mockVoicePreview = {
  url: 'https://runway-output.example.com/preview.mp3',
  durationSecs: 5,
};
