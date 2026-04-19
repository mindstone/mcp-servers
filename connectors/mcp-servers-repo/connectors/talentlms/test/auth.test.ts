import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  createTalentLMSHandlers,
  createRateLimitHandler,
  createAuthFailureHandler,
  createTimeoutHandler,
} from './helpers/talentlms-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, MOCK_DOMAIN } from './fixtures/talentlms-data.js';

describe('Auth — Basic auth header verification', () => {
  let testClient: McpTestClient;
  let capturedAuth: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    capturedAuth = null;
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('sends HTTP Basic Auth header with apiKey: format (colon preserved, empty password)', async () => {
    // Set up interceptor to capture the auth header
    mswServer.use(
      http.get(`https://${MOCK_DOMAIN}.talentlms.com/api/v1/users`, ({ request }) => {
        capturedAuth = request.headers.get('Authorization');
        return HttpResponse.json([]);
      }),
    );

    testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: MOCK_API_KEY,
        TALENTLMS_DOMAIN: MOCK_DOMAIN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_talentlms_users', {});

    expect(capturedAuth).toBeDefined();
    expect(capturedAuth).toContain('Basic');

    // Decode and verify format: "apiKey:" (colon after key, empty password)
    const authValue = capturedAuth!.replace('Basic ', '');
    const decoded = Buffer.from(authValue, 'base64').toString('utf-8');
    expect(decoded).toBe(`${MOCK_API_KEY}:`);
    expect(decoded.endsWith(':')).toBe(true);
  });
});

describe('Auth — error handling', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('handles rate limit (429) with actionable error', async () => {
    // Rate limit handler must come BEFORE the general handlers
    mswServer.use(createRateLimitHandler(), ...createTalentLMSHandlers());

    const testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: MOCK_API_KEY,
        TALENTLMS_DOMAIN: MOCK_DOMAIN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const result = await testClient.callTool('get_talentlms_user', { user_id: 'rate-limit' });
      const data = JSON.parse(result.content[0].text as string);

      expect(data.ok).toBe(false);
      expect(data.error).toContain('Rate limited');
      expect(result.isError).toBe(true);
    } finally {
      await testClient.close();
    }
  });

  it('handles auth failure (401) without leaking secrets', async () => {
    // Auth failure handler must come BEFORE the general handlers
    mswServer.use(createAuthFailureHandler(), ...createTalentLMSHandlers());

    const testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: MOCK_API_KEY,
        TALENTLMS_DOMAIN: MOCK_DOMAIN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const result = await testClient.callTool('get_talentlms_user', { user_id: 'auth-fail' });
      const data = JSON.parse(result.content[0].text as string);

      expect(data.ok).toBe(false);
      expect(data.error).toContain('Authentication failed');
      expect(result.isError).toBe(true);

      // Verify no secrets leaked
      const text = result.content[0].text as string;
      expect(text).not.toContain(MOCK_API_KEY);
    } finally {
      await testClient.close();
    }
  });

  it('returns helpful error when calling tool without configuration', async () => {
    const unconfigured = await createTestClient({
      env: {
        TALENTLMS_API_KEY: '',
        TALENTLMS_DOMAIN: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const result = await unconfigured.callTool('list_talentlms_users', {});
      const data = JSON.parse(result.content[0].text as string);

      expect(data.ok).toBe(false);
      expect(data.error).toContain('not configured');
      expect(result.isError).toBe(true);
    } finally {
      await unconfigured.close();
    }
  });

  it('malformed input rejected by Zod before outbound request', async () => {
    // create_talentlms_user requires first_name, last_name, email, login
    mswServer.use(...createTalentLMSHandlers());

    const client = await createTestClient({
      env: {
        TALENTLMS_API_KEY: MOCK_API_KEY,
        TALENTLMS_DOMAIN: MOCK_DOMAIN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      // Call with missing required fields - Zod should reject before any outbound request
      const result = await client.callTool('create_talentlms_user', {});
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('Auth — timeout handling', () => {
  it('returns actionable timeout error without secrets', async () => {
    // Override REQUEST_TIMEOUT_MS to a short value so test doesn't take 30s
    mswServer.use(createTimeoutHandler());

    // Stub the timeout to a short value
    vi.stubEnv('TALENTLMS_REQUEST_TIMEOUT', '1000');

    const testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: MOCK_API_KEY,
        TALENTLMS_DOMAIN: MOCK_DOMAIN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const result = await testClient.callTool('list_talentlms_users', {});
      const data = JSON.parse(result.content[0].text as string);

      expect(data.ok).toBe(false);
      expect(data.error).toContain('timed out');
      expect(result.isError).toBe(true);

      // No secrets leaked
      const text = result.content[0].text as string;
      expect(text).not.toContain(MOCK_API_KEY);
    } finally {
      await testClient.close();
    }
  }, 30_000);
});

describe('Auth — configure tool', () => {
  it('configure_talentlms updates credentials and subsequent calls succeed', async () => {
    // Start unconfigured
    const testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: '',
        TALENTLMS_DOMAIN: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      // First call should fail — not configured
      const failResult = await testClient.callTool('list_talentlms_users', {});
      const failData = JSON.parse(failResult.content[0].text as string);
      expect(failData.ok).toBe(false);
      expect(failData.error).toContain('not configured');

      // Configure credentials
      mswServer.use(...createTalentLMSHandlers());
      const configResult = await testClient.callTool('configure_talentlms', {
        api_key: MOCK_API_KEY,
        domain: MOCK_DOMAIN,
      });
      const configData = JSON.parse(configResult.content[0].text as string);
      expect(configData.ok).toBe(true);
      expect(configData.message).toContain('configured successfully');

      // Now the next call should succeed with the new credentials
      const successResult = await testClient.callTool('list_talentlms_users', {});
      const successData = JSON.parse(successResult.content[0].text as string);
      expect(successData.ok).toBe(true);
      expect(successData.users).toHaveLength(3);
    } finally {
      await testClient.close();
    }
  });
});
