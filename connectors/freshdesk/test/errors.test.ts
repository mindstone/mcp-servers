import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  createFreshdeskHandlers,
  createFreshdeskTimeoutHandlers,
} from './helpers/freshdesk-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig } from '@mindstone-engineering/mcp-test-harness';

function makeDefaultConfig() {
  return createTempConfig({
    accounts: [
      {
        domain: 'testacme',
        apiKey: 'mock-test-key',
        agentEmail: 'agent@testacme.freshdesk.com',
        authenticatedAt: '2026-01-01T00:00:00Z',
      },
    ],
    defaultAccount: 'testacme',
    defaultAccountKey: 'defaultDomain',
  });
}

describe('Freshdesk error handling', () => {
  let testClient: McpTestClient;
  let cleanupConfig: () => void;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('returns AUTH_FAILED for 401 Unauthorized', async () => {
    const tc = makeDefaultConfig();
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskHandlers());

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_freshdesk_ticket',
      arguments: { ticket_id: 401 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('AUTH_FAILED');
    expect(parsed.error).toContain('Authentication failed');
    expect(parsed.resolution).toBeTruthy();
    expect(text).not.toContain('mock-test-key');
  });

  it('returns NOT_FOUND for 404 Not Found', async () => {
    const tc = makeDefaultConfig();
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskHandlers());

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_freshdesk_ticket',
      arguments: { ticket_id: 404 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('NOT_FOUND');
    expect(parsed.error).toContain('not found');
    expect(parsed.resolution).toBeTruthy();
  });

  it('returns RATE_LIMITED for 429 with Retry-After', async () => {
    const tc = makeDefaultConfig();
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskHandlers());

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_freshdesk_ticket',
      arguments: { ticket_id: 429 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('RATE_LIMITED');
    expect(parsed.error).toContain('Rate limited');
    expect(parsed.error).toContain('60 seconds');
  });

  it('returns error when no account connected', async () => {
    const tc = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
    cleanupConfig = tc.cleanup;

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_tickets',
      arguments: {},
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('No Freshdesk account connected');
  });
});

describe('Freshdesk timeout handling', () => {
  let testClient: McpTestClient;
  let cleanupConfig: () => void;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('returns TIMEOUT error for timed-out requests', async () => {
    const tc = makeDefaultConfig();
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskTimeoutHandlers());

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_tickets',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('TIMEOUT');
    expect(parsed.error).toContain('timed out');
    expect(text).not.toContain('mock-test-key');
  }, 35_000);
});

describe('Freshdesk Basic auth format', () => {
  let testClient: McpTestClient;
  let cleanupConfig: () => void;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('sends correct Authorization: Basic base64(apiKey:X) header', async () => {
    const tc = makeDefaultConfig();
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskHandlers('mock-test-key', 'testacme'));

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_tickets',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    expect(result.isError).toBeUndefined();
    expect(text).toContain('Tickets');
  });
});

describe('Freshdesk Zod validation before outbound request', () => {
  let testClient: McpTestClient;
  let cleanupConfig: () => void;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('configure_freshdesk rejects malformed input before any HTTP request', async () => {
    const tc = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
    cleanupConfig = tc.cleanup;

    let requestCount = 0;
    mswServer.use(
      http.all('*', () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Missing required field: api_key
    const result = await testClient.client.callTool({
      name: 'configure_freshdesk',
      arguments: { domain: 'test' },
    });

    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('search_freshdesk_tickets rejects missing query before any HTTP request', async () => {
    const tc = createTempConfig({
      accounts: [{ domain: 'testacme', apiKey: 'mock-key' }],
      defaultAccount: 'testacme',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tc.cleanup;

    let requestCount = 0;
    mswServer.use(
      http.all('*', () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Missing required field: query
    const result = await testClient.client.callTool({
      name: 'search_freshdesk_tickets',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });
});
