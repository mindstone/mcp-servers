import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createHumaansHandlers, createHumaansUnauthorizedHandlers } from './helpers/humaans-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-humaans-key';

describe('Humaans people tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup(opts?: { key?: string }) {
    mswServer.use(...createHumaansHandlers(opts?.key ?? API_KEY));
    testClient = await createTestClient({
      env: {
        HUMAANS_API_KEY: opts?.key ?? API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  // --- VAL-B1-HUMAANS-002: Bearer auth header ---
  it('sends Authorization: Bearer header on all API requests', async () => {
    let capturedAuth: string | null = null;
    mswServer.use(
      http.get('https://app.humaans.io/api/people', ({ request }) => {
        capturedAuth = request.headers.get('Authorization');
        return HttpResponse.json({
          total: 0,
          limit: 50,
          skip: 0,
          data: [],
        });
      }),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    await testClient.callTool('list_humaans_people', {});
    expect(capturedAuth).toBe(`Bearer ${API_KEY}`);
  });

  // --- VAL-B1-HUMAANS-003: list_humaans_people returns paginated results ---
  it('list_humaans_people returns paginated results', async () => {
    await setup();
    const result = await testClient.callTool('list_humaans_people', {});
    const json = result.json as {
      ok: boolean;
      people: Array<{ id: string; firstName: string; email: string }>;
      count: number;
      total: number;
      pagination: string;
    };

    expect(json.ok).toBe(true);
    expect(json.people).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.total).toBe(2);
    expect(json.people[0]).toHaveProperty('id');
    expect(json.people[0]).toHaveProperty('firstName');
    expect(json.people[0]).toHaveProperty('email');
    expect(json.pagination).toBeDefined();
  });

  it('list_humaans_people returns compact person data with job role info', async () => {
    await setup();
    const result = await testClient.callTool('list_humaans_people', {});
    const json = result.json as {
      ok: boolean;
      people: Array<{ id: string; jobTitle?: string; department?: string }>;
    };

    expect(json.ok).toBe(true);
    expect(json.people[0].jobTitle).toBe('Senior Engineer');
    expect(json.people[0].department).toBe('Engineering');
  });

  it('get_humaans_me returns sanitized profile', async () => {
    await setup();
    const result = await testClient.callTool('get_humaans_me', {});
    const json = result.json as {
      ok: boolean;
      person: Record<string, unknown>;
    };

    expect(json.ok).toBe(true);
    expect(json.person.firstName).toBe('Alice');
    expect(json.person.email).toBe('alice@example.com');
    // Sensitive fields should be stripped
    expect(json.person.taxId).toBeUndefined();
    expect(json.person.personalEmail).toBeUndefined();
    expect(json.person.birthday).toBeUndefined();
    expect(json.person.address).toBeUndefined();
  });

  it('get_humaans_person returns full sanitized profile', async () => {
    await setup();
    const result = await testClient.callTool('get_humaans_person', { personId: 'person-001' });
    const json = result.json as {
      ok: boolean;
      person: Record<string, unknown>;
    };

    expect(json.ok).toBe(true);
    expect(json.person.firstName).toBe('Alice');
    expect(json.person.bio).toBe('A great engineer');
  });

  it('get_humaans_person returns error for non-existent person', async () => {
    await setup();
    const result = await testClient.callTool('get_humaans_person', { personId: 'non-existent' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });

  // --- VAL-COMMON-003: Invalid credentials fail cleanly without leaking secrets ---
  it('invalid credentials return isError without leaking secrets', async () => {
    mswServer.use(...createHumaansUnauthorizedHandlers());

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: 'secret-bad-key-12345', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_humaans_people', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; code: string };

    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
    // Must not leak the secret key
    expect(result.text).not.toContain('secret-bad-key-12345');
  });

  // --- VAL-COMMON-004: Zod rejects malformed input before outbound request ---
  it('rejects malformed personId before making API request', async () => {
    let requestMade = false;
    mswServer.use(
      http.get('https://app.humaans.io/api/*', () => {
        requestMade = true;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Zod schema requires personId to be a non-empty string
    const result = await testClient.callTool('get_humaans_person', { personId: '' });
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  // --- Not configured ---
  it('returns not-configured error when no API key is set', async () => {
    mswServer.use(...createHumaansHandlers());
    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_humaans_people', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });
});
