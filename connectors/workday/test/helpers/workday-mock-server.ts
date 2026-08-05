/**
 * MSW handlers for mocking the Workday REST API.
 */

import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  MOCK_HOST,
  MOCK_TENANT,
  MOCK_ACCESS_TOKEN,
  TOKEN_URL,
  API_BASE,
  createTokenResponse,
  createWorkersListResponse,
  createOrgsListResponse,
  createDirectReportsResponse,
  createWorker,
} from '../fixtures/workday-data.js';

export interface MockServerOptions {
  /** Override token response */
  tokenResponse?: Record<string, unknown>;
  /** Force token endpoint to fail with this status */
  tokenErrorStatus?: number;
  /** Force API requests to fail with this status */
  apiErrorStatus?: number;
}

/**
 * Creates MSW handlers for the Workday API.
 */
export function createWorkdayHandlers(options: MockServerOptions = {}): HttpHandler[] {
  return [
    // OAuth token endpoint
    http.post(TOKEN_URL, async () => {
      if (options.tokenErrorStatus) {
        return HttpResponse.json(
          { error: 'invalid_grant', error_description: 'Mock token error' },
          { status: options.tokenErrorStatus },
        );
      }
      return HttpResponse.json(options.tokenResponse ?? createTokenResponse());
    }),

    // Workers list
    http.get(`${API_BASE}/workers`, async ({ request }) => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      if (options.apiErrorStatus) {
        return HttpResponse.json({ error: 'Mock API error' }, { status: options.apiErrorStatus });
      }

      return HttpResponse.json(createWorkersListResponse());
    }),

    // Worker detail
    http.get(`${API_BASE}/workers/:workerId`, async ({ request, params }) => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      if (options.apiErrorStatus) {
        return HttpResponse.json({ error: 'Mock API error' }, { status: options.apiErrorStatus });
      }

      return HttpResponse.json(createWorker({ id: params.workerId as string }));
    }),

    // Organizations list
    http.get(`${API_BASE}/organizations`, async ({ request }) => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      if (options.apiErrorStatus) {
        return HttpResponse.json({ error: 'Mock API error' }, { status: options.apiErrorStatus });
      }

      return HttpResponse.json(createOrgsListResponse());
    }),

    // Direct reports
    http.get(`${API_BASE}/workers/:workerId/directReports`, async ({ request }) => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      if (options.apiErrorStatus) {
        return HttpResponse.json({ error: 'Mock API error' }, { status: options.apiErrorStatus });
      }

      return HttpResponse.json(createDirectReportsResponse());
    }),
  ];
}
