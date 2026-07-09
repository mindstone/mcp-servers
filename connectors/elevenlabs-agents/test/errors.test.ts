import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsAgentsHandlers,
  createElevenLabsAgentsMissingPermissionHandlers,
  createElevenLabsAgentsUnauthorizedHandlers,
  createElevenLabsAgents422Handlers,
  createElevenLabsAgentsRateLimitHandlers,
  MOCK_API_KEY,
} from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const SECRET_KEY = 'super-secret-elevenlabs-agents-key-999';

type ToolCase = {
  tool: string;
  args: Record<string, unknown>;
  trigger422?: Record<string, unknown>;
  trigger429?: Record<string, unknown>;
};

const READ_TOOL_CASES: ToolCase[] = [
  {
    tool: 'list_agents',
    args: { page_size: 1 },
    trigger422: { page_size: 1, cursor: 'trigger-422' },
    trigger429: { page_size: 1, cursor: 'trigger-429' },
  },
  {
    tool: 'get_agent',
    args: { agent_id: 'agent_test_123' },
    trigger422: { agent_id: 'trigger-422' },
    trigger429: { agent_id: 'trigger-429' },
  },
  {
    tool: 'list_conversations',
    args: { page_size: 1 },
    trigger422: { page_size: 1, cursor: 'trigger-422' },
    trigger429: { page_size: 1, cursor: 'trigger-429' },
  },
  {
    tool: 'get_conversation',
    args: { conversation_id: 'conv_test_123' },
    trigger422: { conversation_id: 'trigger-422' },
    trigger429: { conversation_id: 'trigger-429' },
  },
  {
    tool: 'get_conversation_audio',
    args: { conversation_id: 'conv_test_123' },
    trigger422: { conversation_id: 'trigger-422' },
    trigger429: { conversation_id: 'trigger-429' },
  },
  {
    tool: 'list_phone_numbers',
    args: { page_size: 1 },
    trigger422: { page_size: 1, cursor: 'trigger-422' },
    trigger429: { page_size: 1, cursor: 'trigger-429' },
  },
  {
    tool: 'get_phone_number',
    args: { phone_number_id: 'pn_test_123' },
    trigger422: { phone_number_id: 'trigger-422' },
    trigger429: { phone_number_id: 'trigger-429' },
  },
  {
    tool: 'list_batch_calls',
    args: { limit: 1 },
    trigger422: { limit: 1, last_doc: 'trigger-422' },
    trigger429: { limit: 1, last_doc: 'trigger-429' },
  },
  {
    tool: 'get_batch_call',
    args: { batch_id: 'batch_test_123' },
    trigger422: { batch_id: 'trigger-422' },
    trigger429: { batch_id: 'trigger-429' },
  },
  {
    tool: 'list_knowledge_base_docs',
    args: { page_size: 1 },
    trigger422: { page_size: 1, cursor: 'trigger-422' },
    trigger429: { page_size: 1, cursor: 'trigger-429' },
  },
  {
    tool: 'get_knowledge_base_doc',
    args: { documentation_id: 'doc_test_123' },
    trigger422: { documentation_id: 'trigger-422' },
    trigger429: { documentation_id: 'trigger-429' },
  },
];

const WRITE_TOOL_CASES: ToolCase[] = [
  {
    tool: 'update_phone_number',
    args: { phone_number_id: 'pn_test_123', label: 'Sales desk' },
  },
  {
    tool: 'make_outbound_call',
    args: { phone_number_id: 'pn_test_123', to_number: '+14155559876' },
  },
  {
    tool: 'submit_batch_call',
    args: {
      call_name: 'Renewals wave 1',
      agent_id: 'agent_test_123',
      recipients: [{ phone_number: '+14155559876' }],
    },
  },
  {
    tool: 'cancel_batch_call',
    args: { batch_id: 'batch_test_123' },
  },
  {
    tool: 'retry_batch_call',
    args: { batch_id: 'batch_test_123' },
  },
];

function expectStructuredError(result: Awaited<ReturnType<McpTestClient['callTool']>>, code: string): void {
  expect(result.isError).toBe(true);
  expect(result.json).toMatchObject({ ok: false, code });
}

/** Parse structured error JSON — envelope strings live in parsed fields, not raw result.text. */
function parseErrorBody(result: Awaited<ReturnType<McpTestClient['callTool']>>): Record<string, unknown> {
  return JSON.parse(result.text) as Record<string, unknown>;
}

describe('Error handling — ElevenLabs Agents', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('Authentication', () => {
    it.each(READ_TOOL_CASES)('$tool returns AUTH_REQUIRED when API key is missing', async ({ tool, args }) => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool(tool, args);
      expectStructuredError(result, 'AUTH_REQUIRED');
      expect(parseErrorBody(result).error).toContain('API key not configured');
    });

    it.each(WRITE_TOOL_CASES)('$tool returns AUTH_REQUIRED when API key is missing', async ({ tool, args }) => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool(tool, args);
      expectStructuredError(result, 'AUTH_REQUIRED');
      expect(parseErrorBody(result).error).toContain('API key not configured');
    });

    it.each(READ_TOOL_CASES)('$tool returns AUTH_FAILED on 401 without leaking the key', async ({ tool, args }) => {
      mswServer.use(...createElevenLabsAgentsUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool(tool, args);
      expectStructuredError(result, 'AUTH_FAILED');
      const parsed = parseErrorBody(result);
      expect(result.text).not.toContain(SECRET_KEY);
      expect(parsed.error).toContain('<untrusted-content source="elevenlabs-agents:api:error_detail">');
    });

    it.each(WRITE_TOOL_CASES)('$tool returns AUTH_FAILED on 401 without leaking the key', async ({ tool, args }) => {
      mswServer.use(...createElevenLabsAgentsUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool(tool, args);
      expectStructuredError(result, 'AUTH_FAILED');
      const parsed = parseErrorBody(result);
      expect(result.text).not.toContain(SECRET_KEY);
      expect(parsed.error).toContain('<untrusted-content source="elevenlabs-agents:api:error_detail">');
    });

    it('returns MISSING_PERMISSION on ConvAI 401 missing_permissions payloads', async () => {
      mswServer.use(...createElevenLabsAgentsMissingPermissionHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_conversations', { page_size: 1 });
      expectStructuredError(result, 'MISSING_PERMISSION');
      const parsed = parseErrorBody(result);
      expect(result.text).not.toContain(SECRET_KEY);
      expect(parsed.error).toContain('missing required permission');
      expect(parsed.error).toContain('<untrusted-content source="elevenlabs-agents:api:error_detail">');
      expect(parsed.resolution).toContain('Conversational AI permission enabled');
    });
  });

  describe('FastAPI 422 detail arrays', () => {
    it.each(READ_TOOL_CASES)('$tool surfaces flattened 422 field paths', async ({ tool, trigger422 }) => {
      mswServer.use(...createElevenLabsAgentsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool(tool, trigger422!);
      expectStructuredError(result, 'HTTP_422');
      const parsed = parseErrorBody(result);
      expect(parsed.error).toContain('page_size');
      expect(parsed.error).toContain('greater than or equal to 1');
      expect(parsed.error).toContain('<untrusted-content source="elevenlabs-agents:api:error_detail">');
    });

    it('global 422 handler tolerates null/primitive detail entries', async () => {
      mswServer.use(...createElevenLabsAgents422Handlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_agents', { page_size: 1 });
      expectStructuredError(result, 'HTTP_422');
      const parsed = parseErrorBody(result);
      expect(parsed.error).toContain('query.page_size');
      expect(parsed.error).toContain('greater than or equal to 1');
    });
  });

  describe('Rate limiting', () => {
    it.each(READ_TOOL_CASES)('$tool returns RATE_LIMITED on HTTP 429', async ({ tool, trigger429 }) => {
      mswServer.use(...createElevenLabsAgentsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool(tool, trigger429!);
      expectStructuredError(result, 'RATE_LIMITED');
      expect(result.json).toMatchObject({
        resolution: expect.stringContaining('Rate limited'),
      });
    });

    it.each(WRITE_TOOL_CASES)('$tool returns RATE_LIMITED on global HTTP 429', async ({ tool, args }) => {
      mswServer.use(...createElevenLabsAgentsRateLimitHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool(tool, args);
      expectStructuredError(result, 'RATE_LIMITED');
    });

    it('global 429 handler returns actionable resolution', async () => {
      mswServer.use(...createElevenLabsAgentsRateLimitHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_agents', { page_size: 1 });
      expectStructuredError(result, 'RATE_LIMITED');
    });
  });

  describe('Server resilience', () => {
    it('stays alive after an error and serves a subsequent success', async () => {
      mswServer.use(...createElevenLabsAgentsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const errorResult = await testClient.callTool('get_agent', { agent_id: 'trigger-404' });
      expectStructuredError(errorResult, 'HTTP_404');

      const successResult = await testClient.callTool('list_agents', { page_size: 1 });
      expect(successResult.isError).toBeFalsy();
      expect(successResult.json).toMatchObject({ ok: true, count: 1 });
    });
  });
});

describe('Configure tool — ElevenLabs Agents', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configures API key in-memory and enables read tools', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const before = await testClient.callTool('list_agents', { page_size: 1 });
    expectStructuredError(before, 'AUTH_REQUIRED');

    const configured = await testClient.callTool('configure_elevenlabs_agents_api_key', {
      api_key: MOCK_API_KEY,
    });
    expect(configured.isError).toBeFalsy();
    expect(configured.json).toMatchObject({ ok: true });

    const after = await testClient.callTool('list_agents', { page_size: 1 });
    expect(after.isError).toBeFalsy();
    expect(after.json).toMatchObject({ ok: true, count: 1 });
  });

  it('rejects empty api_key via Zod before any network call', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('configure_elevenlabs_agents_api_key', { api_key: '' });
    expect(result.isError).toBe(true);
  });
});
