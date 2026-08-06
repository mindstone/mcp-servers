import { http, HttpResponse } from 'msw';
import {
  mockProfiles,
  mockBalances,
  mockRates,
  mockRecipients,
  mockRecipientPage,
  mockRequirementGroups,
  mockQuote,
  mockTransfer,
  mockTransfers,
  mockStatement,
  mockActivitiesPage,
} from '../fixtures/wise-data.js';

const BASE = 'https://api.wise.com';
const API_TOKEN = 'mock-wise-test-token';

/**
 * Creates MSW handlers that mock the Wise API.
 * Verifies the Bearer token on every request.
 */
export function createWiseHandlers(expectedToken = API_TOKEN, base = BASE) {
  const checkAuth = (request: Request) => {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${expectedToken}`) {
      return HttpResponse.json(
        { error: 'invalid_token', error_description: 'Authentication failed' },
        { status: 401 },
      );
    }
    return null;
  };

  return [
    // ── Profiles ──────────────────────────────────────────────────

    http.get(`${base}/v2/profiles`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockProfiles);
    }),

    // ── Balances ──────────────────────────────────────────────────

    http.get(`${base}/v4/profiles/:profileId/balances`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockBalances);
    }),

    // ── Balance statement ─────────────────────────────────────────

    http.get(`${base}/v1/profiles/:profileId/balance-statements/:balanceId/statement.json`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockStatement);
    }),

    // ── Activities ────────────────────────────────────────────────

    http.get(`${base}/v1/profiles/:profileId/activities`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockActivitiesPage);
    }),

    // ── Rates ─────────────────────────────────────────────────────

    http.get(`${base}/v1/rates`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockRates);
    }),

    // ── Recipients ────────────────────────────────────────────────

    http.get(`${base}/v2/accounts`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockRecipientPage);
    }),

    http.get(`${base}/v2/accounts/:accountId`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = parseInt(params.accountId as string, 10);

      if (id === 404) {
        return HttpResponse.json({ error: 'not_found' }, { status: 404 });
      }
      if (id === 429) {
        // Retry-After: 0 keeps the GET retry loop fast in tests; the
        // client still exhausts its retries and surfaces RATE_LIMITED.
        return HttpResponse.json(
          { error: 'rate_limited' },
          { status: 429, headers: { 'Retry-After': '0' } },
        );
      }

      const recipient = mockRecipients.find((r) => r.id === id);
      if (!recipient) {
        return HttpResponse.json({ error: 'not_found' }, { status: 404 });
      }
      return HttpResponse.json(recipient);
    }),

    http.post(`${base}/v1/accounts`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(
        {
          id: 777003,
          profileId: body.profile,
          name: { fullName: body.accountHolderName, givenName: null, familyName: null },
          currency: body.currency,
          country: 'DE',
          type: body.type,
          legalEntityType: 'PERSON',
          active: true,
          details: body.details,
          accountSummary: '(mock) new recipient',
          ownedByCustomer: body.ownedByCustomer ?? false,
        },
        { status: 200 },
      );
    }),

    // ── Account requirements ──────────────────────────────────────

    http.get(`${base}/v1/quotes/:quoteId/account-requirements`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockRequirementGroups);
    }),

    // ── Quotes ────────────────────────────────────────────────────

    http.post(`${base}/v3/profiles/:profileId/quotes`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockQuote);
    }),

    // ── Transfers ─────────────────────────────────────────────────

    http.get(`${base}/v1/transfers`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockTransfers);
    }),

    http.get(`${base}/v1/transfers/:transferId`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = parseInt(params.transferId as string, 10);
      if (id !== mockTransfer.id) {
        return HttpResponse.json({ error: 'not_found' }, { status: 404 });
      }
      return HttpResponse.json(mockTransfer);
    }),

    http.post(`${base}/v1/transfers`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const body = (await request.json()) as Record<string, unknown>;
      const details = (body.details ?? {}) as Record<string, unknown>;
      return HttpResponse.json({
        ...mockTransfer,
        id: 888002,
        targetAccount: body.targetAccount,
        quoteUuid: body.quoteUuid,
        customerTransactionId: body.customerTransactionId,
        details: { reference: details.reference },
      });
    }),

    http.post(`${base}/v3/profiles/:profileId/transfers/:transferId/payments`, async ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const transferId = parseInt(params.transferId as string, 10);
      if (transferId === 999) {
        // Wise signals funding failure with HTTP 200 + status REJECTED.
        return HttpResponse.json({
          type: 'BALANCE',
          status: 'REJECTED',
          errorCode: 'transfer.insufficient_funds',
        });
      }
      return HttpResponse.json({ type: 'BALANCE', status: 'COMPLETED', errorCode: null });
    }),

    http.put(`${base}/v1/transfers/:transferId/cancel`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = parseInt(params.transferId as string, 10);
      if (id !== mockTransfer.id) {
        return HttpResponse.json(
          { error: 'transfer.cancellation.not.allowed' },
          { status: 409 },
        );
      }
      return HttpResponse.json({ ...mockTransfer, status: 'cancelled' });
    }),
  ];
}
