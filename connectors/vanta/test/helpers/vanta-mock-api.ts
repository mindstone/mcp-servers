import { http, HttpResponse } from 'msw';

export const MOCK_CLIENT_ID = 'vci_test_clientid';
export const MOCK_CLIENT_SECRET = 'vcs_test_clientsecret';
export const MOCK_ACCESS_TOKEN = 'vmt_test_access_token_abc123';

export interface CapturedTokenRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Counter wrapper around the token endpoint so tests can assert how many
 * POST /oauth/token calls happened in a given window (used by the
 * single-flight token-exchange test).
 */
export function createTokenCounter() {
  let count = 0;
  const handler = http.post('https://api.vanta.com/oauth/token', async () => {
    count += 1;
    return HttpResponse.json({
      access_token: MOCK_ACCESS_TOKEN,
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });
  return {
    handler,
    get count() {
      return count;
    },
    reset() {
      count = 0;
    },
  };
}

export function createCapturingTokenHandler(urls = ['https://api.vanta.com/oauth/token']) {
  const requests: CapturedTokenRequest[] = [];
  const handlers = urls.map((url) =>
    http.post(url, async ({ request }) => {
      const body = await request.json();
      requests.push({
        url: request.url,
        body: typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {},
      });
      return HttpResponse.json({
        access_token: MOCK_ACCESS_TOKEN,
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }),
  );

  return {
    handlers,
    get requests() {
      return requests;
    },
    reset() {
      requests.length = 0;
    },
  };
}

export const successTokenHandler = http.post('https://api.vanta.com/oauth/token', () =>
  HttpResponse.json({
    access_token: MOCK_ACCESS_TOKEN,
    expires_in: 3600,
    token_type: 'Bearer',
  }),
);

export const slowTokenHandler = (delayMs: number) =>
  http.post('https://api.vanta.com/oauth/token', async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return HttpResponse.json({
      access_token: MOCK_ACCESS_TOKEN,
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });

export const listControlsHandler = (items: Array<Record<string, unknown>> = []) =>
  http.get('https://api.vanta.com/v1/controls', () =>
    HttpResponse.json({
      results: {
        data: items,
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
  );

export const listVulnerabilitiesHandler = (items: Array<Record<string, unknown>> = []) =>
  http.get('https://api.vanta.com/v1/vulnerabilities', () =>
    HttpResponse.json({
      results: {
        data: items,
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
  );

export const unauthorizedHandler = () =>
  http.get('https://api.vanta.com/v1/controls', () =>
    HttpResponse.json(
      { message: 'Invalid or expired bearer token' },
      { status: 401 },
    ),
  );

export const rateLimitedHandler = () =>
  http.get('https://api.vanta.com/v1/controls', () =>
    HttpResponse.json(
      { message: 'rate limited' },
      { status: 429, headers: { 'Retry-After': '1' } },
    ),
  );
