import { http, HttpResponse } from 'msw';
import {
  MOCK_API_KEY,
  mockThemes,
  mockFolders,
  mockGenerationId,
  makeGenerationResponse,
  makeCompletedStatus,
} from '../fixtures/gamma-data.js';

const BASE = 'https://public-api.gamma.app/v1.0';

/**
 * Verify x-api-key header. Returns a 401 HttpResponse on failure, null on success.
 */
function checkAuth(request: Request, expectedKey = MOCK_API_KEY) {
  const key = request.headers.get('x-api-key');
  if (key !== expectedKey) {
    return HttpResponse.json(
      { error: 'Invalid API key' },
      { status: 401 },
    );
  }
  return null;
}

/**
 * Creates MSW handlers for the Gamma API.
 * Verifies x-api-key header on every request.
 */
export function createGammaHandlers(expectedApiKey = MOCK_API_KEY) {
  return [
    // POST /generations
    http.post(`${BASE}/generations`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(makeGenerationResponse());
    }),

    // POST /generations/from-template
    http.post(`${BASE}/generations/from-template`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(makeGenerationResponse('gen-template-123'));
    }),

    // GET /generations/:id
    http.get(`${BASE}/generations/:id`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;

      const id = params.id as string;
      if (id === 'invalid-id') {
        return HttpResponse.json({ error: 'Generation not found' }, { status: 404 });
      }
      return HttpResponse.json(makeCompletedStatus(id));
    }),

    // GET /themes
    http.get(`${BASE}/themes`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({
        data: mockThemes,
        hasMore: false,
        nextCursor: null,
      });
    }),

    // GET /folders
    http.get(`${BASE}/folders`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({
        data: mockFolders,
        hasMore: false,
        nextCursor: null,
      });
    }),
  ];
}

/**
 * Creates handlers that return 401 for all Gamma API requests.
 */
export function createGammaUnauthorizedHandlers() {
  return [
    http.get(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Invalid API key' }, { status: 401 }),
    ),
    http.post(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Invalid API key' }, { status: 401 }),
    ),
  ];
}

/**
 * Creates handlers that time out for all Gamma API requests.
 */
export function createGammaTimeoutHandlers() {
  return [
    http.get(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.post(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
  ];
}

/**
 * Creates bridge mock handlers for Gamma configure flow.
 */
export function createGammaBridgeHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/gamma/configure`, async ({ request }) => {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${token}`) {
        return HttpResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401 },
        );
      }
      return HttpResponse.json({ success: true });
    }),
  ];
}

/**
 * Creates bridge handlers that return 401.
 */
export function createGammaBridge401Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/gamma/configure`, () => {
      return HttpResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 },
      );
    }),
  ];
}

/**
 * Creates bridge handlers that return 403.
 */
export function createGammaBridge403Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/gamma/configure`, () => {
      return HttpResponse.json(
        { success: false, error: 'Forbidden' },
        { status: 403 },
      );
    }),
  ];
}

/**
 * Creates bridge handlers that return { success: false }.
 */
export function createGammaBridgeFailureHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/gamma/configure`, async ({ request }) => {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${token}`) {
        return HttpResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401 },
        );
      }
      return HttpResponse.json({ success: false, error: 'Account validation failed' });
    }),
  ];
}

/**
 * Creates export polling handlers with configurable behavior.
 *
 * @param generationId The generation ID to respond to
 * @param options Configuration for the polling behavior
 */
export function createExportPollingHandlers(
  generationId: string,
  options: {
    /** Number of calls before pdfUrl appears (0 = immediate) */
    callsBeforePdfUrl?: number;
    /** Number of calls before pptxUrl appears (0 = immediate) */
    callsBeforePptxUrl?: number;
    /** Never return export URLs (for timeout testing) */
    neverReturnExportUrl?: boolean;
    /** Custom gammaUrl */
    gammaUrl?: string;
  } = {},
) {
  let callCount = 0;
  const gammaUrl = options.gammaUrl ?? `https://gamma.app/docs/Test-${generationId}`;

  return [
    http.get(`${BASE}/generations/${generationId}`, ({ request }) => {
      const key = request.headers.get('x-api-key');
      if (!key) {
        return HttpResponse.json({ error: 'Invalid API key' }, { status: 401 });
      }

      callCount++;
      const result: Record<string, unknown> = {
        generationId,
        status: 'completed',
        gammaUrl,
        credits: { deducted: 150, remaining: 2850 },
      };

      if (!options.neverReturnExportUrl) {
        if (
          options.callsBeforePdfUrl !== undefined &&
          callCount > options.callsBeforePdfUrl
        ) {
          result.pdfUrl = `https://public-api.gamma.app/mock-exports/${generationId}.pdf`;
        }
        if (
          options.callsBeforePptxUrl !== undefined &&
          callCount > options.callsBeforePptxUrl
        ) {
          result.pptxUrl = `https://public-api.gamma.app/mock-exports/${generationId}.pptx`;
        }
      }

      return HttpResponse.json(result);
    }),
  ];
}

/**
 * Creates mock download handlers for export files.
 */
export function createExportDownloadHandlers() {
  return [
    http.get('https://public-api.gamma.app/mock-exports/*.pdf', () => {
      return new HttpResponse(Buffer.from('mock-pdf-content'), {
        headers: { 'Content-Type': 'application/pdf' },
      });
    }),
    http.get('https://public-api.gamma.app/mock-exports/*.pptx', () => {
      return new HttpResponse(
        Buffer.from('mock-pptx-content'),
        {
          headers: {
            'Content-Type':
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          },
        },
      );
    }),
  ];
}

/**
 * Creates a download handler that returns 500 for export files.
 */
export function createExportDownloadFailureHandlers() {
  return [
    http.get('https://public-api.gamma.app/mock-exports/*', () => {
      return HttpResponse.text('Internal Server Error', { status: 500 });
    }),
  ];
}
