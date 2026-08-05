import * as fs from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsAgentsHandlers, createConversationFeedbackCapturingHandler, MOCK_API_KEY } from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('conversation tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists conversations with filters', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_conversations', {
      page_size: 1,
      agent_id: 'agent_test_123',
      call_successful: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.json.count).toBe(1);
    expect(result.json.next_cursor).toBe('cursor_conversations_2');
  });

  it('gets a conversation and downloads its audio', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const conversation = await testClient.callTool('get_conversation', { conversation_id: 'conv_custom_456' });
    expect(conversation.isError).toBeFalsy();
    expect(conversation.json.conversation.conversation_id).toBe('conv_custom_456');

    const audio = await testClient.callTool('get_conversation_audio', { conversation_id: 'conv_custom_456' });
    expect(audio.isError).toBeFalsy();
    expect(fs.existsSync(audio.json.file_path)).toBe(true);
    if (fs.existsSync(audio.json.file_path)) fs.unlinkSync(audio.json.file_path);
  });

  it('submits like/dislike feedback for a conversation', async () => {
    const { handler, captured } = createConversationFeedbackCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('submit_conversation_feedback', {
      conversation_id: 'conv_custom_456',
      feedback: 'dislike',
    });

    expect(result.isError).toBeFalsy();
    expect(result.json).toMatchObject({
      ok: true,
      conversation_id: 'conv_custom_456',
      feedback: 'dislike',
    });
    expect(captured.body).toEqual({ feedback: 'dislike' });
  });

  it('submit_conversation_feedback surfaces upstream errors', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('submit_conversation_feedback', {
      conversation_id: 'trigger-404',
      feedback: 'like',
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'HTTP_404' });
  });
});
