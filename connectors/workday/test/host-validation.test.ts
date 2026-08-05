/**
 * Adversarial coverage for host validation and the DNS re-resolution guard:
 * non-canonical IP spellings, IPv6 variants, ports/user-info, and hostnames
 * resolving to non-public addresses must all be refused before any
 * credential-bearing request leaves the process.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_HOST,
  MOCK_TENANT,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  TOKEN_URL,
  API_BASE,
  createTokenResponse,
} from './fixtures/workday-data.js';

const CONFIGURED_ENV = {
  WORKDAY_HOST: MOCK_HOST,
  WORKDAY_TENANT: MOCK_TENANT,
  WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
  WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  MCP_HOST_BRIDGE_STATE: '',
};

describe('non-canonical / disguised host rejection', () => {
  let testClient: McpTestClient;
  let tokenRequestCount: number;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const disguisedHosts = [
    { host: '127.1', label: 'short-form loopback (127.1)', message: 'localhost or a private IP' },
    { host: '127.0.1', label: 'three-octet loopback (127.0.1)', message: 'localhost or a private IP' },
    { host: '0x7f000001', label: 'hex loopback (0x7f000001)', message: 'localhost or a private IP' },
    { host: '2130706433', label: 'integer loopback (2130706433)', message: 'localhost or a private IP' },
    { host: '0177.0.0.1', label: 'octal loopback (0177.0.0.1)', message: 'localhost or a private IP' },
    { host: '[::1]', label: 'IPv6 loopback ([::1])', message: 'localhost or a private IP' },
    // Bare ::1 is not even a valid URL host — refused as a syntax error.
    { host: '::1', label: 'bare IPv6 loopback (::1)', message: null },
    { host: '[::ffff:127.0.0.1]', label: 'IPv4-mapped IPv6 loopback', message: 'localhost or a private IP' },
    { host: '0.0.0.0', label: 'unspecified (0.0.0.0)', message: 'localhost or a private IP' },
    { host: '100.64.0.1', label: 'CGNAT shared range (100.64.0.0/10)', message: 'localhost or a private IP' },
    { host: 'localhost.localdomain', label: 'localhost.localdomain', message: 'localhost or a private IP' },
  ];

  for (const { host, label, message } of disguisedHosts) {
    it(`rejects ${label} before any outbound request`, async () => {
      tokenRequestCount = 0;
      mswServer.use(
        http.post(TOKEN_URL, async () => {
          tokenRequestCount++;
          return HttpResponse.json(createTokenResponse());
        }),
      );

      testClient = await createTestClient({ env: CONFIGURED_ENV });
      const result = await testClient.callTool('configure_workday_credentials', {
        host,
        tenant: MOCK_TENANT,
        client_id: MOCK_CLIENT_ID,
        client_secret: MOCK_CLIENT_SECRET,
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      if (message) expect(json.error as string).toContain(message);
      expect(tokenRequestCount).toBe(0);
    });
  }

  it('rejects host with an explicit port', async () => {
    tokenRequestCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, async () => {
        tokenRequestCount++;
        return HttpResponse.json(createTokenResponse());
      }),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });
    const result = await testClient.callTool('configure_workday_credentials', {
      host: `${MOCK_HOST}:8443`,
      tenant: MOCK_TENANT,
      client_id: MOCK_CLIENT_ID,
      client_secret: MOCK_CLIENT_SECRET,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error as string).toContain('bare hostname');
    expect(tokenRequestCount).toBe(0);
  });

  it('rejects host with embedded user-info', async () => {
    testClient = await createTestClient({ env: CONFIGURED_ENV });
    const result = await testClient.callTool('configure_workday_credentials', {
      host: `user:pass@${MOCK_HOST}`,
      tenant: MOCK_TENANT,
      client_id: MOCK_CLIENT_ID,
      client_secret: MOCK_CLIENT_SECRET,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
  });

  it('accepts a valid public hostname', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${API_BASE}/workers`, async () =>
        HttpResponse.json({ data: [], total: 0 }),
      ),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });
    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });
});

describe('DNS re-resolution guard', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('refuses a hostname that resolves to a private IPv4 address', async () => {
    let tokenRequestCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, async () => {
        tokenRequestCount++;
        return HttpResponse.json(createTokenResponse());
      }),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });
    const { setDnsLookupForTesting } = await import('../../src/auth.js');
    setDnsLookupForTesting(async () => [{ address: '10.0.0.7', family: 4 }]);

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('HOST_NOT_PUBLIC');
    // The refusal happens before the credential-bearing token exchange.
    expect(tokenRequestCount).toBe(0);
    // The resolved address is not echoed into model-visible output.
    expect(result.text).not.toContain('10.0.0.7');
  });

  it('refuses a hostname that resolves to an IPv6 loopback', async () => {
    testClient = await createTestClient({ env: CONFIGURED_ENV });
    const { setDnsLookupForTesting } = await import('../../src/auth.js');
    setDnsLookupForTesting(async () => [{ address: '::1', family: 6 }]);

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('HOST_NOT_PUBLIC');
  });

  it('fails closed when DNS resolution errors', async () => {
    testClient = await createTestClient({ env: CONFIGURED_ENV });
    const { setDnsLookupForTesting } = await import('../../src/auth.js');
    setDnsLookupForTesting(async () => {
      throw new Error('ENOTFOUND');
    });

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('HOST_UNRESOLVABLE');
    expect(result.text).not.toContain('ENOTFOUND');
  });

  it('configure refuses a hostname resolving to a private address', async () => {
    testClient = await createTestClient({ env: CONFIGURED_ENV });
    const { setDnsLookupForTesting } = await import('../../src/auth.js');
    setDnsLookupForTesting(async () => [{ address: '192.168.1.10', family: 4 }]);

    const result = await testClient.callTool('configure_workday_credentials', {
      host: MOCK_HOST,
      tenant: MOCK_TENANT,
      client_id: MOCK_CLIENT_ID,
      client_secret: MOCK_CLIENT_SECRET,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error as string).toContain('non-public address');
  });
});
