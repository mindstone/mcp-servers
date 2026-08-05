/**
 * Token redaction in the request layer (security invariant: secrets never
 * reach logs). HubSpot's token-info endpoint is addressed BY access token, so
 * the secret sits in the request path — the client must redact it from the
 * debug log line and from the structured error summary on every call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubSpotClient } from '../src/api/hubspot-client.js';
import logger from '../src/utils/logger.js';

const ACCESS_TOKEN = 'pat-na1-secret-access-token';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('access-token redaction in request logging', () => {
  it('redacts the token from the debug log of a token-path request', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ user: 'jane@example.com', hub_id: 12345678, user_id: 1001, scopes: ['oauth'] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const client = new HubSpotClient(ACCESS_TOKEN);
    await client.getTokenInfo();

    const serialized = JSON.stringify(debugSpy.mock.calls);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).toContain('[REDACTED]');
    // The endpoint stays recognisable for debugging — only the secret is cut.
    expect(serialized).toContain('/oauth/v1/access-tokens/');
  });

  it('redacts the token from the error summary on a failing token-path request', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'invalid token', category: 'AUTHENTICATION_ERROR' }),
      { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } },
    )));

    const client = new HubSpotClient(ACCESS_TOKEN);
    const thrown = await client.getTokenInfo().catch((error: unknown) => error);

    const serialized = JSON.stringify(errorSpy.mock.calls);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).toContain('[REDACTED]');
    // The thrown error must not smuggle the token out either.
    expect(JSON.stringify(thrown)).not.toContain(ACCESS_TOKEN);
    expect((thrown as Error).message).not.toContain(ACCESS_TOKEN);
  });

  it('leaves token-free endpoints untouched in logs', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: '123', properties: {}, createdAt: '', updatedAt: '', archived: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const client = new HubSpotClient(ACCESS_TOKEN);
    await client.getObject('contacts', '123');

    const serialized = JSON.stringify(debugSpy.mock.calls);
    expect(serialized).toContain('GET /crm/v3/objects/contacts/123');
    expect(serialized).not.toContain('[REDACTED]');
  });
});
