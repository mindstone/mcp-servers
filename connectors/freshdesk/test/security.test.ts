import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createFreshdeskHandlers } from './helpers/freshdesk-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig } from '@mindstone/mcp-test-harness';

describe('Subdomain validation — configure_freshdesk rejects malicious domains', () => {
  let testClient: McpTestClient;
  let cleanupConfig: (() => void) | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  const maliciousDomains = [
    { domain: 'evil.com/path', label: 'slash injection' },
    { domain: 'foo@evil.com', label: '@ injection' },
    { domain: 'evil.com?', label: '? hijack' },
    { domain: 'evil.com#frag', label: '# injection' },
    { domain: 'evil.com', label: 'dot (FQDN) injection' },
    { domain: 'evil%2Ecom', label: 'percent-encoded chars' },
    { domain: '   ', label: 'whitespace only' },
    { domain: 'ACME', label: 'uppercase chars' },
    { domain: '-leadinghyphen', label: 'leading hyphen' },
    { domain: 'trailinghyphen-', label: 'trailing hyphen' },
  ];

  for (const { domain, label } of maliciousDomains) {
    it(`rejects ${label}: "${domain}"`, async () => {
      // Isolate from any developer-machine config; no mock handlers
      // needed — request should never be made
      const tempConfig = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
      cleanupConfig = tempConfig.cleanup;
      testClient = await createTestClient({
        env: {
          FRESHDESK_CONFIG_PATH: tempConfig.configPath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_freshdesk', {
        domain,
        api_key: 'test-api-key',
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('INVALID_SUBDOMAIN');
    });
  }

  it('rejects empty string (caught by Zod schema)', async () => {
    const tempConfig = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
    cleanupConfig = tempConfig.cleanup;
    testClient = await createTestClient({
      env: {
        FRESHDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_freshdesk', {
      domain: '',
      api_key: 'test-api-key',
    });

    // Empty string is caught by Zod .min(1) before reaching validateSubdomain
    expect(result.isError).toBe(true);
  });

  const validSubdomains = [
    { domain: 'acme', label: 'simple alpha' },
    { domain: 'my-company', label: 'hyphenated' },
    { domain: 'test123', label: 'alphanumeric' },
    { domain: 'a', label: 'single char' },
    { domain: '123', label: 'all numeric' },
    { domain: 'a-b-c', label: 'multiple hyphens' },
  ];

  for (const { domain, label } of validSubdomains) {
    it(`accepts valid subdomain: "${domain}" (${label})`, async () => {
      const tempConfig = createTempConfig({
        accounts: [],
        defaultAccountKey: 'defaultDomain',
      });
      cleanupConfig = tempConfig.cleanup;

      testClient = await createTestClient({
        env: {
          FRESHDESK_CONFIG_PATH: tempConfig.configPath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_freshdesk', {
        domain,
        api_key: 'test-api-key',
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.domain).toBe(domain);
    });
  }
});

describe('Subdomain validation — freshdeskFetch defence-in-depth', () => {
  let testClient: McpTestClient;
  let cleanupConfig: (() => void) | undefined;
  let outboundRequestCount: number;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('rejects malicious domain at fetch level (slash injection)', async () => {
    outboundRequestCount = 0;

    // Set up a handler to count any outbound requests
    mswServer.use(
      ...createFreshdeskHandlers('test-api-key', 'evil.com/steal'),
    );

    // Directly test freshdeskFetch by calling a tool with a pre-configured
    // malicious domain account
    const tempConfig = createTempConfig({
      accounts: [
        {
          domain: 'evil.com/steal',
          apiKey: 'test-api-key',
          authenticatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      defaultAccount: 'evil.com/steal',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tempConfig.cleanup;

    testClient = await createTestClient({
      env: {
        FRESHDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // Attempt to list tickets with the malicious domain — freshdeskFetch should reject
    const result = await testClient.callTool('list_freshdesk_tickets', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_SUBDOMAIN');
  });

  it('rejects malicious domain at fetch level (dot injection)', async () => {
    const tempConfig = createTempConfig({
      accounts: [
        {
          domain: 'evil.com',
          apiKey: 'test-api-key',
          authenticatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      defaultAccount: 'evil.com',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tempConfig.cleanup;

    testClient = await createTestClient({
      env: {
        FRESHDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_freshdesk_tickets', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_SUBDOMAIN');
  });

  it('rejects malicious domain at fetch level (@ injection)', async () => {
    const tempConfig = createTempConfig({
      accounts: [
        {
          domain: 'foo@evil.com',
          apiKey: 'test-api-key',
          authenticatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      defaultAccount: 'foo@evil.com',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tempConfig.cleanup;

    testClient = await createTestClient({
      env: {
        FRESHDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_freshdesk_tickets', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_SUBDOMAIN');
  });
});

describe('No outbound HTTP for invalid domains', () => {
  let testClient: McpTestClient;
  let cleanupConfig: (() => void) | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('no HTTP request is made when domain is invalid', async () => {
    let requestMade = false;
    const { http, HttpResponse } = await import('msw');

    // Install a catch-all handler to detect any outbound request
    mswServer.use(
      http.get('*', () => {
        requestMade = true;
        return new HttpResponse(null, { status: 500 });
      }),
      http.post('*', () => {
        requestMade = true;
        return new HttpResponse(null, { status: 500 });
      }),
    );

    const tempConfig = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
    cleanupConfig = tempConfig.cleanup;
    testClient = await createTestClient({
      env: {
        FRESHDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('configure_freshdesk', {
      domain: 'evil.com/steal',
      api_key: 'stolen-key',
    });

    // This verifies no HTTP request was made to the attacker-controlled host
    // The validation should reject before any network call
    expect(requestMade).toBe(false);
  });
});

describe('Error messages are host-neutral', () => {
  let testClient: McpTestClient;
  let cleanupConfig: (() => void) | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('no-account error uses host-neutral language', async () => {
    // Isolate from any developer-machine config so the no-account error
    // path is exercised regardless of local state.
    const tempConfig = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
    cleanupConfig = tempConfig.cleanup;
    testClient = await createTestClient({
      env: {
        FRESHDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_freshdesk_tickets', {});
    const text = result.text;

    expect(text).not.toContain('Mindstone');
    expect(text).not.toContain('mindstone');
  });
});
