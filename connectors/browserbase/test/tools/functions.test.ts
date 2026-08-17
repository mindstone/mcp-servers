import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import {
  createBrowserbaseHandlers,
  MOCK_API_KEY,
  FUNCTION_ID,
  VERSION_ID,
  INVOCATION_ID,
  BUILD_ID,
} from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Function tools — Browserbase', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  const makeClient = async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
    return testClient;
  };

  it('list_functions returns functions with wrapped names', async () => {
    const client = await makeClient();
    const result = await client.callTool('list_functions', { limit: 20, offset: 0 });
    const parsed = result.json as { ok: boolean; functions: Array<{ id: string; name: string }>; total: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.functions[0].id).toBe(FUNCTION_ID);
    expect(parsed.functions[0].name).toBe(
      '<untrusted-content source="browserbase:list_functions:function.name">acme-scrape-pricing</untrusted-content>',
    );
  });

  it('get_function / invoke_function happy paths', async () => {
    const client = await makeClient();

    const got = await client.callTool('get_function', { function_id: FUNCTION_ID });
    expect((got.json as { ok: boolean; id: string }).id).toBe(FUNCTION_ID);

    const invoked = await client.callTool('invoke_function', {
      function_id: FUNCTION_ID,
      params: { url: 'https://example.com' },
    });
    const invokedJson = invoked.json as { ok: boolean; invocation: { status: string }; message: string };
    expect(invokedJson.ok).toBe(true);
    expect(invokedJson.invocation.status).toBe('PENDING');
    expect(invokedJson.message).toContain('202');
  });

  it('invoke_function 404 maps to NOT_FOUND', async () => {
    const client = await makeClient();
    const result = await client.callTool('invoke_function', { function_id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('NOT_FOUND');
  });

  it('list_function_versions / get_function_version return schemas unwrapped (caller must parse them)', async () => {
    const client = await makeClient();

    const versions = await client.callTool('list_function_versions', { function_id: FUNCTION_ID });
    const versionsJson = versions.json as { ok: boolean; versions: Array<{ id: string }>; total: number };
    expect(versionsJson.ok).toBe(true);
    expect(versionsJson.versions[0].id).toBe(VERSION_ID);

    const version = await client.callTool('get_function_version', { version_id: VERSION_ID });
    const versionJson = version.json as {
      ok: boolean;
      userParamsSchema: { properties: { url: { type: string } } };
    };
    expect(versionJson.ok).toBe(true);
    expect(versionJson.userParamsSchema.properties.url.type).toBe('string');
  });

  it('list_function_invocations / get_function_invocation wrap results and cause text', async () => {
    const client = await makeClient();

    const list = await client.callTool('list_function_invocations', { version_id: VERSION_ID });
    const listJson = list.json as { ok: boolean; invocations: Array<{ id: string; status: string }> };
    expect(listJson.ok).toBe(true);
    expect(listJson.invocations[0].id).toBe(INVOCATION_ID);

    const got = await client.callTool('get_function_invocation', { invocation_id: INVOCATION_ID });
    const gotJson = got.json as { ok: boolean; status: string; results: { price: number; summary: string } };
    expect(gotJson.ok).toBe(true);
    expect(gotJson.status).toBe('COMPLETED');
    // Function-output string values are wrapped; numbers and keys stay raw.
    expect(gotJson.results.price).toBe(42);
    expect(gotJson.results.summary).toBe(
      '<untrusted-content source="browserbase:get_function_invocation:invocation.results">Found 1 plan on the Acme Corp page</untrusted-content>',
    );
  });

  it('get_function_invocation_logs / get_function_build_logs wrap log messages', async () => {
    const client = await makeClient();

    const invLogs = await client.callTool('get_function_invocation_logs', { invocation_id: INVOCATION_ID });
    const invLogsJson = invLogs.json as { ok: boolean; logs: Array<{ message: string; timestamp: number }> };
    expect(invLogsJson.ok).toBe(true);
    expect(invLogsJson.logs[0].message).toContain('<untrusted-content');
    expect(invLogsJson.logs[0].timestamp).toBe(1780000000000);

    const buildLogs = await client.callTool('get_function_build_logs', { build_id: BUILD_ID });
    const buildLogsJson = buildLogs.json as { ok: boolean; logs: Array<{ message: string }> };
    expect(buildLogsJson.ok).toBe(true);
    // The mock build log carries a breakout attempt — it must be neutralised.
    expect(buildLogsJson.logs[0].message).toContain('<\\/untrusted-content>');
  });

  it('list_function_builds / get_function_build return builds with wrapped author-controlled fields', async () => {
    const client = await makeClient();

    const list = await client.callTool('list_function_builds', { status: 'COMPLETED' });
    const listJson = list.json as { ok: boolean; builds: Array<{ id: string }>; total: number };
    expect(listJson.ok).toBe(true);
    expect(listJson.builds[0].id).toBe(BUILD_ID);

    const got = await client.callTool('get_function_build', { build_id: BUILD_ID });
    const gotJson = got.json as {
      ok: boolean;
      request: { entrypoint: string };
      builtFunctions: Array<{ name: string }>;
    };
    expect(gotJson.ok).toBe(true);
    expect(gotJson.request.entrypoint).toContain('<untrusted-content');
    expect(gotJson.builtFunctions[0].name).toContain('<untrusted-content');
  });

  it('get_function_build 404 maps to NOT_FOUND', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_function_build', { build_id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('NOT_FOUND');
  });
});
