import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createBrowserbaseHandlers, MOCK_API_KEY } from './helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const EXPECTED_TOOLS = [
  'configure_browserbase_api_key',
  'create_agent',
  'create_agent_run',
  'create_context',
  'create_session',
  'delete_agent',
  'delete_certificate',
  'delete_context',
  'delete_download',
  'delete_extension',
  'end_session',
  'fetch_url',
  'get_agent',
  'get_agent_run',
  'get_agent_run_messages',
  'get_certificate',
  'get_context',
  'get_download_file',
  'get_download_info',
  'get_extension',
  'get_function',
  'get_function_build',
  'get_function_build_logs',
  'get_function_invocation',
  'get_function_invocation_logs',
  'get_function_version',
  'get_project',
  'get_project_usage',
  'get_session',
  'get_session_debug_urls',
  'get_session_logs',
  'get_session_recording_downloads',
  'get_session_replay_playlist',
  'get_session_replays',
  'invoke_function',
  'list_agent_runs',
  'list_agents',
  'list_certificates',
  'list_downloads',
  'list_function_builds',
  'list_function_invocations',
  'list_function_versions',
  'list_functions',
  'list_projects',
  'list_sessions',
  'request_session_recording_downloads',
  'stop_agent_run',
  'update_agent',
  'upload_certificate',
  'upload_extension',
  'upload_session_file',
  'wait_for_agent_run',
  'web_search',
];

const READ_ONLY_TOOLS = [
  'list_projects', 'get_project', 'get_project_usage',
  'list_sessions', 'get_session', 'get_session_debug_urls', 'get_session_logs',
  'get_session_replays', 'get_session_replay_playlist', 'get_session_recording_downloads',
  'get_context',
  'list_agents', 'get_agent',
  'list_agent_runs', 'get_agent_run', 'wait_for_agent_run', 'get_agent_run_messages',
  'list_downloads', 'get_download_info', 'get_download_file',
  'get_extension',
  'list_certificates', 'get_certificate',
  'fetch_url', 'web_search',
  'list_functions', 'get_function', 'list_function_versions', 'get_function_version',
  'list_function_invocations', 'get_function_invocation', 'get_function_invocation_logs',
  'list_function_builds', 'get_function_build', 'get_function_build_logs',
];

const DESTRUCTIVE_TOOLS = [
  'configure_browserbase_api_key',
  'create_session', 'end_session', 'upload_session_file',
  'create_context', 'delete_context',
  'create_agent', 'update_agent', 'delete_agent',
  'create_agent_run', 'stop_agent_run',
  'delete_download',
  'upload_extension', 'delete_extension',
  'upload_certificate', 'delete_certificate',
  'invoke_function',
];

describe('Smoke test — Browserbase MCP server', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('should register all 53 tools via MCP protocol', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map(t => t.name).sort();

    expect(toolsResult.tools).toHaveLength(53);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });

  it('should have non-empty descriptions for all tools', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      expect(tool.description, `Tool ${tool.name} should have a description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(50);
    }
  });

  it('should have annotations on all tools', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();

    for (const tool of toolsResult.tools) {
      expect(tool.annotations, `Tool ${tool.name} should have annotations`).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations!.destructiveHint).toBe('boolean');
      expect(tool.annotations!.openWorldHint, `${tool.name} should be openWorld (except configure)`)
        .toBe(tool.name === 'configure_browserbase_api_key' ? false : true);

      if (READ_ONLY_TOOLS.includes(tool.name)) {
        expect(tool.annotations!.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
        expect(tool.annotations!.destructiveHint, `${tool.name} should not be destructive`).toBe(false);
      }

      if (DESTRUCTIVE_TOOLS.includes(tool.name)) {
        expect(tool.annotations!.destructiveHint, `${tool.name} should be destructive`).toBe(true);
        expect(tool.annotations!.readOnlyHint, `${tool.name} should not be readOnly`).toBe(false);
      }
    }
  });

  it('should have valid inputSchema for all tools', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      expect(tool.inputSchema, `Tool ${tool.name} should have inputSchema`).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('returns AUTH_REQUIRED with setup guidance when no API key is configured', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_projects', {});
    expect(result.isError).toBe(true);
    const parsed = result.json as { ok: boolean; code: string; resolution: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('AUTH_REQUIRED');
    expect(parsed.resolution).toContain('configure_browserbase_api_key');
  });

  it('configure_browserbase_api_key validates input and configures the session key', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const bad = await testClient.callTool('configure_browserbase_api_key', { api_key: '' });
    expect(bad.isError).toBe(true);

    const configured = await testClient.callTool('configure_browserbase_api_key', { api_key: MOCK_API_KEY });
    expect(configured.isError).toBeFalsy();
    const configuredJson = configured.json as { ok: boolean; message: string };
    expect(configuredJson.ok).toBe(true);
    // The key must never be echoed back in tool output.
    expect(configuredJson.message).not.toContain(MOCK_API_KEY);

    // After configuring, authenticated tools work.
    const projects = await testClient.callTool('list_projects', {});
    expect(projects.isError).toBeFalsy();
    expect((projects.json as { ok: boolean }).ok).toBe(true);
  });
});
