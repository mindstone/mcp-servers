/**
 * Test fixtures for the Napkin connector.
 */

export const MOCK_API_KEY = 'mock-napkin-test-key';

export const mockRequestId = 'req-abc123-uuid';

export function makeCreateVisualResponse(id = mockRequestId) {
  return {
    id,
    status: 'pending' as const,
    request: { content: 'test', format: 'svg' },
  };
}

export function makeCompletedStatus(id = mockRequestId) {
  return {
    id,
    status: 'completed' as const,
    request: { content: 'test', format: 'svg' },
    generated_files: [
      {
        url: `https://api.napkin.ai/v1/visual/${id}/file/output.svg`,
        visual_id: 'vis-001',
        visual_query: 'flowchart',
        style_id: 'style-default',
        width: 570,
        height: 630,
        color_mode: 'light',
      },
    ],
    credits: { consumed: 20 },
  };
}

export function makePendingStatus(id = mockRequestId) {
  return {
    id,
    status: 'pending' as const,
  };
}

export function makeFailedStatus(
  id = mockRequestId,
  error = { message: 'No credits remaining', code: 'no_credits' },
) {
  return {
    id,
    status: 'failed' as const,
    error,
  };
}

export const mockSvgContent = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>';
export const mockPngContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
