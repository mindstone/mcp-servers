import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createServiceNowHandlers } from './helpers/servicenow-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const EMPTY_ENV = {
  SERVICENOW_INSTANCE: '',
  SERVICENOW_USERNAME: '',
  SERVICENOW_PASSWORD: '',
  MCP_HOST_BRIDGE_STATE: '',
};

describe('Instance validation — configure_servicenow rejects malicious instances', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const maliciousInstances = [
    { instance: 'evil.com/path', label: 'slash injection' },
    { instance: 'foo@evil.com', label: '@ injection' },
    { instance: 'evil.com?', label: '? hijack' },
    { instance: 'evil.com#frag', label: '# injection' },
    { instance: 'evil%2Ecom', label: 'percent-encoded chars' },
    { instance: 'acme.evil.com', label: 'non-servicenow FQDN' },
    { instance: 'acme.service-now.com.evil.com', label: 'suffix spoof' },
    { instance: '-leadinghyphen', label: 'leading hyphen' },
    { instance: 'trailinghyphen-', label: 'trailing hyphen' },
  ];

  for (const { instance, label } of maliciousInstances) {
    it(`rejects ${label}: "${instance}"`, async () => {
      let requestMade = false;
      mswServer.use(
        http.all('*', () => {
          requestMade = true;
          return new HttpResponse(null, { status: 500 });
        }),
      );

      testClient = await createTestClient({ env: EMPTY_ENV });

      const result = await testClient.callTool('configure_servicenow', {
        instance,
        username: 'user',
        password: 'pass',
      });

      const json = result.json as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('Invalid instance');
      // Rejection happens before any outbound request.
      expect(requestMade).toBe(false);
    });
  }

  const validInstances = [
    { instance: 'acme', label: 'simple alpha' },
    { instance: 'my-company', label: 'hyphenated' },
    { instance: 'test123', label: 'alphanumeric' },
    { instance: 'a-b-c', label: 'multiple hyphens' },
    { instance: 'acme.service-now.com', label: 'bare FQDN' },
    { instance: 'https://acme.service-now.com/', label: 'full URL' },
  ];

  for (const { instance, label } of validInstances) {
    it(`accepts valid instance: "${instance}" (${label})`, async () => {
      mswServer.use(...createServiceNowHandlers('user', 'pass'));
      testClient = await createTestClient({ env: EMPTY_ENV });

      const result = await testClient.callTool('configure_servicenow', {
        instance,
        username: 'user',
        password: 'pass',
      });
      const json = result.json as { ok: boolean; message: string };
      expect(json.ok).toBe(true);
      expect(json.message).toContain('configured successfully');
      expect(json.message).toContain('.service-now.com');
    });
  }
});

describe('Credential hygiene', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('error output never contains the password or its base64 form', async () => {
    mswServer.use(
      http.get('https://test-instance.service-now.com/api/now/table/incident', () =>
        HttpResponse.json(
          { error: { message: 'User Not Authenticated' } },
          { status: 401 },
        ),
      ),
    );

    testClient = await createTestClient({
      env: {
        SERVICENOW_INSTANCE: 'test-instance',
        SERVICENOW_USERNAME: 'test-user',
        SERVICENOW_PASSWORD: 'test-pass',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_servicenow_incidents', {});
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('test-pass');
    expect(result.text).not.toContain(
      Buffer.from('test-user:test-pass').toString('base64'),
    );
  });

  it('error output never contains the instance-independent credential material', async () => {
    // 500 with a JSON error body: the API error message is surfaced but
    // credentials must not be.
    mswServer.use(
      http.get('https://test-instance.service-now.com/api/now/table/sys_user', () =>
        HttpResponse.json(
          { error: { message: 'Internal table error', detail: 'stack trace here' } },
          { status: 500 },
        ),
      ),
    );

    testClient = await createTestClient({
      env: {
        SERVICENOW_INSTANCE: 'test-instance',
        SERVICENOW_USERNAME: 'test-user',
        SERVICENOW_PASSWORD: 'test-pass',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_servicenow_users', {});
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('test-pass');
    expect(result.text).not.toContain('test-user');
  });
});
