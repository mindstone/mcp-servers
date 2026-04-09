/**
 * Test fixtures for the Nano Banana connector.
 */

export const MOCK_API_KEY = 'mock-gemini-test-key-abc123';

/**
 * A tiny valid base64-encoded PNG (1x1 transparent pixel).
 */
export const MOCK_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Create a mock Gemini generateContent response with an image.
 */
export function createMockGeminiResponse(options?: {
  imageData?: string;
  imageMimeType?: string;
  text?: string;
}): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];

  if (options?.text) {
    parts.push({ text: options.text });
  }

  parts.push({
    inlineData: {
      data: options?.imageData ?? MOCK_IMAGE_BASE64,
      mimeType: options?.imageMimeType ?? 'image/png',
    },
  });

  return {
    candidates: [
      {
        content: {
          parts,
        },
      },
    ],
  };
}

/**
 * Create a mock Gemini blocked response.
 */
export function createMockBlockedResponse(reason = 'SAFETY'): Record<string, unknown> {
  return {
    candidates: [],
    promptFeedback: {
      blockReason: reason,
    },
  };
}

/**
 * Create a mock Gemini empty response (no candidates).
 */
export function createMockEmptyResponse(): Record<string, unknown> {
  return {
    candidates: [],
  };
}
