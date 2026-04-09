import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createServiceNowHandlers } from './helpers/servicenow-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const TEST_ENV = {
  SERVICENOW_INSTANCE: 'test-instance',
  SERVICENOW_USERNAME: 'test-user',
  SERVICENOW_PASSWORD: 'test-pass',
  MCP_HOST_BRIDGE_STATE: '',
};

describe('ServiceNow knowledge tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('search_servicenow_knowledge returns articles', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('search_servicenow_knowledge', {});
    const json = result.json as {
      ok: boolean;
      articles: Array<{ number: string }>;
      count: number;
    };
    expect(json.ok).toBe(true);
    expect(json.articles).toHaveLength(2);
    expect(json.count).toBe(2);
  });

  it('search_servicenow_knowledge with keyword filters results', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('search_servicenow_knowledge', {
      query: 'VPN',
    });
    const json = result.json as {
      ok: boolean;
      articles: Array<{ number: string; short_description: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.articles).toHaveLength(1);
    expect(json.articles[0].short_description).toContain('VPN');
  });

  it('get_servicenow_knowledge_article by number returns article', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_knowledge_article', {
      identifier: 'KB0010001',
    });
    const json = result.json as {
      ok: boolean;
      article: { number: string; short_description: string };
    };
    expect(json.ok).toBe(true);
    expect(json.article.number).toBe('KB0010001');
    expect(json.article.short_description).toContain('VPN');
  });

  it('get_servicenow_knowledge_article by sys_id returns article', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_knowledge_article', {
      identifier: 'kb-sys-id-001',
    });
    const json = result.json as {
      ok: boolean;
      article: { sys_id: string };
    };
    expect(json.ok).toBe(true);
    expect(json.article.sys_id).toBe('kb-sys-id-001');
  });

  it('get_servicenow_knowledge_article with nonexistent number returns not found', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_knowledge_article', {
      identifier: 'KB9999999',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not found');
  });
});
