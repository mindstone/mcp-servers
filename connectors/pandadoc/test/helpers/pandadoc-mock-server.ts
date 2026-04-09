import { http, HttpResponse } from 'msw';
import {
  mockDocuments,
  mockDocumentDetails,
  mockTemplates,
  mockCreateFromTemplateResponse,
  mockSendResponse,
} from '../fixtures/pandadoc-data.js';

const BASE = 'https://api.pandadoc.com/public/v1';

/**
 * Creates MSW handlers that mock the PandaDoc API.
 * Verifies `Authorization: API-Key {key}` header on every request.
 */
export function createPandaDocHandlers(expectedKey = 'test-pandadoc-key') {
  const checkAuth = (request: Request) => {
    const auth = request.headers.get('Authorization');
    if (auth !== `API-Key ${expectedKey}`) {
      return HttpResponse.json({ type: 'unauthorized', detail: 'Invalid API key' }, { status: 401 });
    }
    return null;
  };

  return [
    // GET /documents (list)
    http.get(`${BASE}/documents`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const url = new URL(request.url);
      const q = url.searchParams.get('q');
      let filtered = mockDocuments;
      if (q) {
        filtered = mockDocuments.filter(d => d.name.toLowerCase().includes(q.toLowerCase()));
      }
      return HttpResponse.json({ results: filtered });
    }),

    // GET /documents/:id (status)
    http.get(`${BASE}/documents/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const url = new URL(request.url);
      const id = params.id as string;

      // Check if this is a details or download request (handled by other handlers)
      if (url.pathname.endsWith('/details') || url.pathname.endsWith('/download')) {
        return;
      }

      const doc = mockDocuments.find(d => d.id === id);
      if (!doc) {
        return HttpResponse.json({ type: 'not_found', detail: 'Document not found' }, { status: 404 });
      }
      return HttpResponse.json(doc);
    }),

    // GET /documents/:id/details
    http.get(`${BASE}/documents/:id/details`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = params.id as string;
      if (id === 'doc-1') {
        return HttpResponse.json(mockDocumentDetails);
      }
      return HttpResponse.json({ type: 'not_found', detail: 'Document not found' }, { status: 404 });
    }),

    // GET /documents/:id/download
    http.get(`${BASE}/documents/:id/download`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = params.id as string;
      if (id === 'doc-1') {
        return new HttpResponse(Buffer.from('PDF_CONTENT_MOCK'), {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        });
      }
      if (id === 'doc-not-ready') {
        return HttpResponse.json(
          { type: 'conflict', detail: 'Document not ready for download' },
          { status: 409 },
        );
      }
      return HttpResponse.json({ type: 'not_found', detail: 'Document not found' }, { status: 404 });
    }),

    // POST /documents (create from template)
    http.post(`${BASE}/documents`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockCreateFromTemplateResponse);
    }),

    // POST /documents/:id/send
    http.post(`${BASE}/documents/:id/send`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = params.id as string;
      if (id === 'doc-1') {
        return HttpResponse.json(mockSendResponse);
      }
      if (id === 'doc-not-ready') {
        return HttpResponse.json(
          { type: 'conflict', detail: 'Document is not in draft status' },
          { status: 409 },
        );
      }
      return HttpResponse.json({ type: 'not_found', detail: 'Document not found' }, { status: 404 });
    }),

    // GET /templates
    http.get(`${BASE}/templates`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const url = new URL(request.url);
      const q = url.searchParams.get('q');
      let filtered = mockTemplates;
      if (q) {
        filtered = mockTemplates.filter(t => t.name.toLowerCase().includes(q.toLowerCase()));
      }
      return HttpResponse.json({ results: filtered });
    }),
  ];
}

/**
 * Creates a handler that returns 401 for all PandaDoc API requests.
 */
export function createPandaDocUnauthorizedHandlers() {
  return [
    http.get(`${BASE}/*`, () =>
      HttpResponse.json({ type: 'unauthorized', detail: 'Invalid API key' }, { status: 401 }),
    ),
    http.post(`${BASE}/*`, () =>
      HttpResponse.json({ type: 'unauthorized', detail: 'Invalid API key' }, { status: 401 }),
    ),
  ];
}

/**
 * Creates a handler that times out for all PandaDoc API requests.
 */
export function createPandaDocTimeoutHandlers() {
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
