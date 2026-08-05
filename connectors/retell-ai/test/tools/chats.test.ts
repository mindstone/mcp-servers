import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY, lastListChatsBody } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Chat tools — Retell AI', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('list_chat_agents returns chat-channel agents', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({ name: 'list_chat_agents', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agents).toBeInstanceOf(Array);
    expect(parsed.agents[0].agent_id).toBe('chat_agent_test_321');
    expect(parsed.agents[0].channel).toBe('chat');
    expect(parsed.agents[0].agent_name).toBe(
      '<untrusted-content source="retell:list_chat_agents:agent_name">Chat Test Agent</untrusted-content>',
    );
  });

  it('list_chats returns chats with wrapped transcripts', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({ name: 'list_chats', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.chats).toBeInstanceOf(Array);
    expect(parsed.count).toBe(1);
    expect(parsed.pagination_key).toBe('chats_page_2');
    // transcript is user-authored → wrapped per AGENTS.md invariant #6 (FOX-3490).
    expect(parsed.chats[0].transcript).toBe(
      '<untrusted-content source="retell:list_chats:transcript">Agent: Hi there!\nUser: Hello, I have a question about my order.</untrusted-content>',
    );
    expect(parsed.chats[0].message_with_tool_calls[1].content).toBe(
      '<untrusted-content source="retell:list_chats:message_with_tool_calls.content">Hello, I have a question about my order.</untrusted-content>',
    );
    expect(parsed.chats[0].chat_analysis.chat_summary).toBe(
      '<untrusted-content source="retell:list_chats:chat_analysis.chat_summary">The user asked about their order.</untrusted-content>',
    );
  });

  it('list_chats maps timestamp filters to Retell operator objects', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    await testClient.client.callTool({
      name: 'list_chats',
      arguments: {
        agent_id: ['chat_agent_test_321'],
        filter_criteria: { after_start_timestamp: '2026-01-01' },
      },
    });

    const after = new Date('2026-01-01').getTime();
    expect(lastListChatsBody?.filter_criteria).toEqual({
      agent: [{ agent_id: 'chat_agent_test_321' }],
      start_timestamp: { type: 'number', op: 'ge', value: after },
    });

    await testClient.client.callTool({
      name: 'list_chats',
      arguments: {
        filter_criteria: { after_start_timestamp: 1735689600000, before_start_timestamp: 1738368000000 },
      },
    });

    expect(lastListChatsBody?.filter_criteria).toEqual({
      start_timestamp: { type: 'range', op: 'bt', value: [1735689600000, 1738368000000] },
    });
  });

  it('get_chat returns the full chat with wrapped analysis', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_chat',
      arguments: { chat_id: 'chat_test_001' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.chat_id).toBe('chat_test_001');
    expect(parsed.chat_analysis.chat_summary).toBe(
      '<untrusted-content source="retell:get_chat:chat_analysis.chat_summary">The user asked about their order.</untrusted-content>',
    );
  });

  it('get_chat returns structured error for 404', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_chat',
      arguments: { chat_id: 'nonexistent' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('HTTP_404');
  });
});
