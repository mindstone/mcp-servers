/**
 * Test fixtures for the Gamma connector.
 */

export const MOCK_API_KEY = 'mock-gamma-test-key';

export const mockThemes = [
  {
    id: 'theme-1',
    name: 'Corporate Blue',
    type: 'custom' as const,
    colorKeywords: ['blue', 'professional'],
  },
  {
    id: 'theme-2',
    name: 'Oasis',
    type: 'standard' as const,
    colorKeywords: ['green', 'nature'],
  },
];

export const mockFolders = [
  { id: 'folder-1', name: 'Client Presentations' },
  { id: 'folder-2', name: 'Internal Docs' },
];

export const mockGenerationId = 'gen-abc123';

export function makeGenerationResponse(id = mockGenerationId) {
  return { generationId: id };
}

export function makeCompletedStatus(
  id = mockGenerationId,
  options: {
    gammaUrl?: string;
    pdfUrl?: string;
    pptxUrl?: string;
    credits?: { deducted: number; remaining: number };
  } = {},
) {
  return {
    generationId: id,
    status: 'completed' as const,
    gammaUrl: options.gammaUrl ?? 'https://gamma.app/docs/Test-Deck-xyz123',
    pdfUrl: options.pdfUrl,
    pptxUrl: options.pptxUrl,
    credits: options.credits ?? { deducted: 150, remaining: 2850 },
  };
}

export function makePendingStatus(id = mockGenerationId) {
  return {
    generationId: id,
    status: 'pending' as const,
  };
}

export function makeFailedStatus(id = mockGenerationId, error = 'Generation failed') {
  return {
    generationId: id,
    status: 'failed' as const,
    error,
  };
}
