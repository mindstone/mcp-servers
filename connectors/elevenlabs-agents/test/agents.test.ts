import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createCreateAgentCapturingHandler,
  createDuplicateAgentCapturingHandler,
  createElevenLabsAgentsHandlers,
  createSimulateConversationCapturingHandler,
  createUpdateAgentCapturingHandler,
  MOCK_API_KEY,
} from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('agents tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists agents with pagination metadata', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_agents', { page_size: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.json.count).toBe(1);
    expect(result.json.next_cursor).toBe('cursor_agents_2');
  });

  it('gets a single agent object', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_agent', { agent_id: 'agent_custom_456' });
    expect(result.isError).toBeFalsy();
    expect(result.json.agent.agent_id).toBe('agent_custom_456');
  });

  it('create_agent maps the first-class fields into nested conversation_config paths', async () => {
    const { handler, captured } = createCreateAgentCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_agent', {
      name: 'Support triage',
      system_prompt: 'Resolve the issue calmly.',
      first_message: 'Thanks for calling Support.',
      voice_id: 'voice_abc',
      language: 'en',
      llm_model: 'gpt-realtime',
      temperature: 0.3,
      knowledge_base_document_ids: ['doc_test_123', 'doc_test_456'],
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      name: 'Support triage',
      conversation_config: {
        agent: {
          prompt: {
            prompt: 'Resolve the issue calmly.',
            llm_model: 'gpt-realtime',
            temperature: 0.3,
            knowledge_base_document_ids: ['doc_test_123', 'doc_test_456'],
          },
          first_message: 'Thanks for calling Support.',
          language: 'en',
        },
        tts: {
          voice_id: 'voice_abc',
        },
      },
    });
    expect(result.json.agent_id).toBe('agent_created_123');
    expect(result.json.agent.agent_id).toBe('agent_created_123');
  });

  it('update_agent deep-merges advanced_config into the first-class PATCH body', async () => {
    const { handler, captured } = createUpdateAgentCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('update_agent', {
      agent_id: 'agent_test_123',
      system_prompt: 'New system prompt',
      advanced_config: {
        conversation_config: {
          agent: {
            prompt: {
              temperature: 0.8,
            },
          },
        },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      conversation_config: {
        agent: {
          prompt: {
            prompt: 'New system prompt',
            temperature: 0.8,
          },
        },
      },
    });
    expect(result.json.agent.agent_id).toBe('agent_test_123');
  });

  it('update_agent lets advanced_config win when it targets the same nested path', async () => {
    const { handler, captured } = createUpdateAgentCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('update_agent', {
      agent_id: 'agent_test_123',
      voice_id: 'voice_from_first_class',
      advanced_config: {
        conversation_config: {
          tts: {
            voice_id: 'voice_from_advanced_config',
          },
        },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      conversation_config: {
        tts: {
          voice_id: 'voice_from_advanced_config',
        },
      },
    });
  });

  it('duplicate_agent forwards the optional name and returns the duplicate id', async () => {
    const { handler, captured } = createDuplicateAgentCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('duplicate_agent', {
      agent_id: 'agent_test_123',
      name: 'Support triage v2',
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({ name: 'Support triage v2' });
    expect(result.json.agent_id).toBe('agent_duplicate_123');
  });

  it('delete_agent removes the agent and returns a confirmation payload', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('delete_agent', { agent_id: 'agent_test_123' });

    expect(result.isError).toBeFalsy();
    expect(result.json).toMatchObject({
      ok: true,
      agent_id: 'agent_test_123',
    });
  });

  it('simulate_conversation maps a short user message into simulated_user_config', async () => {
    const { handler, captured } = createSimulateConversationCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('simulate_conversation', {
      agent_id: 'agent_test_123',
      user_message: 'I need to reschedule my appointment.',
      language: 'en',
      disable_first_message_interruptions: true,
      new_turns_limit: 8,
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      simulation_specification: {
        simulated_user_config: {
          first_message: 'I need to reschedule my appointment.',
          language: 'en',
          disable_first_message_interruptions: true,
        },
      },
      new_turns_limit: 8,
    });
    expect(result.json.simulated_conversation).toHaveLength(1);
    expect(result.json.analysis).toMatchObject({
      evaluation_criteria_results_list: expect.any(Array),
    });
  });
});
