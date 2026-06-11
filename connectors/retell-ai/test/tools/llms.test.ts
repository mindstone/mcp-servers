import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('LLM tools — Retell AI', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('list_retell_llms returns LLM configs', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_retell_llms',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.llms).toBeInstanceOf(Array);
    expect(parsed.llms[0].llm_id).toBe('llm_test_789');
  });

  it('get_retell_llm returns LLM config', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_retell_llm',
      arguments: { llm_id: 'llm_test_789' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.llm_id).toBe('llm_test_789');
    expect(parsed.general_prompt).toBeTruthy();
  });

  it('create_retell_llm creates new LLM config', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_retell_llm',
      arguments: {
        general_prompt: 'You are a sales assistant.',
        begin_message: 'Hi there!',
        model: 'gpt-4o',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.llm_id).toBe('llm_new_001');
  });

  it('update_retell_llm updates LLM config', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'update_retell_llm',
      arguments: {
        llm_id: 'llm_test_789',
        general_prompt: 'Updated prompt',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    // general_prompt is external text → wrapped per AGENTS.md invariant #6 (FOX-3490).
    expect(parsed.general_prompt).toBe(
      '<untrusted-content source="retell:update_retell_llm:general_prompt">Updated prompt</untrusted-content>',
    );
  });
});
