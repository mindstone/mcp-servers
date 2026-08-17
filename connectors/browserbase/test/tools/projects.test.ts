import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createBrowserbaseHandlers, MOCK_API_KEY, PROJECT_ID } from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Project tools — Browserbase', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('list_projects returns projects with ok:true and wraps names as untrusted', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_projects', {});
    expect(result.isError).toBeFalsy();
    const parsed = result.json as {
      ok: boolean;
      projects: Array<{ id: string; name: string; concurrency: number }>;
      count: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.projects[0].id).toBe(PROJECT_ID);
    // name is user-authored in the dashboard → wrapped per AGENTS.md invariant #6.
    expect(parsed.projects[0].name).toBe(
      '<untrusted-content source="browserbase:list_projects:project.name">Acme Corp Automations</untrusted-content>',
    );
  });

  it('get_project returns one project', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_project', { project_id: PROJECT_ID });
    const parsed = result.json as { ok: boolean; id: string; defaultTimeout: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(PROJECT_ID);
    expect(parsed.defaultTimeout).toBe(300);
  });

  it('get_project_usage returns usage numbers', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_project_usage', { project_id: PROJECT_ID });
    const parsed = result.json as { ok: boolean; browserMinutes: number; proxyBytes: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.browserMinutes).toBe(123);
    expect(parsed.proxyBytes).toBe(456789);
  });

  it('401 maps to AUTH_REQUIRED with an actionable resolution', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: 'bb_live_test_wrong_key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_projects', {});
    expect(result.isError).toBe(true);
    const parsed = result.json as { ok: boolean; code: string; resolution: string; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('AUTH_REQUIRED');
    expect(parsed.resolution).toContain('configure_browserbase_api_key');
    // Upstream detail is enveloped, and the API key never appears in output.
    expect(parsed.error).toContain('<untrusted-content source="browserbase:error">');
    expect(JSON.stringify(parsed)).not.toContain('bb_live_test_wrong_key');
  });

  it('404 maps to NOT_FOUND with list-tools guidance', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_project', { project_id: 'nonexistent' });
    expect(result.isError).toBe(true);
    const parsed = result.json as { ok: boolean; code: string; resolution: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('NOT_FOUND');
    expect(parsed.resolution).toContain('list_');
  });
});
