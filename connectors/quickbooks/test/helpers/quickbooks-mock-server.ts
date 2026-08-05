/**
 * MSW handlers for mocking the QuickBooks Online API and Intuit OAuth.
 */

import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  MOCK_ACCESS_TOKEN,
  TOKEN_URL,
  SANDBOX_API_BASE,
  PRODUCTION_API_BASE,
  createTokenResponse,
  createInvoicesQueryResponse,
  createCustomersQueryResponse,
  createBillsQueryResponse,
  createVendorsQueryResponse,
  createAccountsQueryResponse,
  createEmployeesQueryResponse,
  createReportResponse,
} from '../fixtures/quickbooks-data.js';

export interface MockServerOptions {
  /** Override token response */
  tokenResponse?: Record<string, unknown>;
  /** Force token endpoint to fail with this status */
  tokenErrorStatus?: number;
  /** Force API requests to fail with this status */
  apiErrorStatus?: number;
  /** Use sandbox API base instead of production */
  useSandbox?: boolean;
}

/**
 * Creates MSW handlers for the QuickBooks Online API.
 */
export function createQuickBooksHandlers(options: MockServerOptions = {}): HttpHandler[] {
  const apiBase = options.useSandbox ? SANDBOX_API_BASE : PRODUCTION_API_BASE;

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

    // Query endpoint
    http.get(`${apiBase}/query`, async ({ request }) => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      if (options.apiErrorStatus) {
        return HttpResponse.json(
          { Fault: { Error: [{ Message: 'Mock API error', Detail: 'Test error detail' }] } },
          { status: options.apiErrorStatus },
        );
      }

      const url = new URL(request.url);
      const query = url.searchParams.get('query') ?? '';

      if (query.includes('Invoice')) {
        return HttpResponse.json(createInvoicesQueryResponse());
      }
      if (query.includes('Customer')) {
        return HttpResponse.json(createCustomersQueryResponse());
      }
      if (query.includes('Bill')) {
        return HttpResponse.json(createBillsQueryResponse());
      }
      if (query.includes('Vendor')) {
        return HttpResponse.json(createVendorsQueryResponse());
      }
      if (query.includes('Account')) {
        return HttpResponse.json(createAccountsQueryResponse());
      }
      if (query.includes('Employee')) {
        return HttpResponse.json(createEmployeesQueryResponse());
      }

      // Default: empty response
      return HttpResponse.json({ QueryResponse: {} });
    }),

    // Reports endpoint — must precede the generic /:entityType/:entityId
    // handler below, which would otherwise swallow /reports/{name}.
    http.get(`${apiBase}/reports/:reportName`, async ({ request, params }) => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      if (options.apiErrorStatus) {
        return HttpResponse.json(
          { Fault: { Error: [{ Message: 'Mock API error', Detail: 'Test error detail' }] } },
          { status: options.apiErrorStatus },
        );
      }

      return HttpResponse.json(createReportResponse(params.reportName as string));
    }),

    // Entity detail endpoints
    http.get(`${apiBase}/:entityType/:entityId`, async ({ request, params }) => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      if (options.apiErrorStatus) {
        return HttpResponse.json(
          { Fault: { Error: [{ Message: 'Mock API error' }] } },
          { status: options.apiErrorStatus },
        );
      }

      const entityType = (params.entityType as string);
      const entityId = params.entityId as string;
      const capitalized = entityType.charAt(0).toUpperCase() + entityType.slice(1);

      return HttpResponse.json({
        [capitalized]: { Id: entityId, DisplayName: `Test ${capitalized}`, Active: true },
      });
    }),

    // Create entity endpoints (POST)
    http.post(`${apiBase}/:entityType`, async ({ request, params }) => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      if (options.apiErrorStatus) {
        return HttpResponse.json(
          { Fault: { Error: [{ Message: 'Mock API error' }] } },
          { status: options.apiErrorStatus },
        );
      }

      const entityType = (params.entityType as string);
      const capitalized = entityType.charAt(0).toUpperCase() + entityType.slice(1);
      const body = await request.json() as Record<string, unknown>;

      return HttpResponse.json({
        [capitalized]: { Id: '999', ...body },
      });
    }),
  ];
}
