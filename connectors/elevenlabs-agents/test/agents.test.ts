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
import { ATTACK_PAYLOAD, CLOSE_TAG_AGENT_NAME } from './fixtures/elevenlabs-agents-data.js';

type Json = Record<string, any>;

/**
 * Close-tag *variants* (`</UNTRUSTED-CONTENT \t>`) are defanged to the single
 * canonical form on the way out, and unescaping restores that canonical form — so a
 * value carrying a breakout attempt round-trips normalized, not byte-identical.
 * Ordinary text, and the canonical close tag itself, round-trip exactly.
 */
const ATTACK_PAYLOAD_AFTER_ROUND_TRIP =
  ATTACK_PAYLOAD.replace(/<\/untrusted-content\s*>/gi, '</untrusted-content>');

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

  it('update_agent rejects requests that only provide agent_id', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('update_agent', {
      agent_id: 'agent_test_123',
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENTS',
    });
    expect(result.json.error).toContain('Provide at least one field to update: name/system_prompt/first_message/voice_id/language/llm_model/temperature/knowledge_base_document_ids or advanced_config.');
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

  /**
   * Round-trip contract (adversarial round 2, F2). `get_agent` returns every
   * non-structural string enveloped, and these tools tell the model to read the
   * config before patching it — so the model hands enveloped values straight back to
   * `update_agent`. Storing the envelope upstream would corrupt the agent, so the
   * write side strips exactly one envelope. The *output* boundary is untouched:
   * hostile prose in a config-shaped field is still enveloped on the way out.
   */
  describe('enveloped-input round-trip contract', () => {
    it('update_agent restores first-class fields copied out of a get_agent response', async () => {
      const { handler, captured } = createUpdateAgentCapturingHandler();
      mswServer.use(handler, ...createElevenLabsAgentsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const read = await testClient.callTool('get_agent', { agent_id: 'agent_test_123' });
      const agent = (read.json as Json).agent as Json;
      const agentConfig = agent.conversation_config.agent as Json;

      // Precondition: these really do come back wrapped, so the model has no raw copy.
      expect(String(agent.name)).toContain('<untrusted-content source=');
      expect(String(agentConfig.language)).toContain('<untrusted-content source=');
      expect(String(agentConfig.prompt.llm_model)).toContain('<untrusted-content source=');

      const write = await testClient.callTool('update_agent', {
        agent_id: 'agent_test_123',
        name: agent.name,
        language: agentConfig.language,
        llm_model: agentConfig.prompt.llm_model,
        system_prompt: agentConfig.prompt.prompt,
      });

      expect(write.isError).toBeFalsy();
      expect(captured.body).toEqual({
        name: CLOSE_TAG_AGENT_NAME,
        conversation_config: {
          agent: {
            language: 'en',
            prompt: {
              prompt: ATTACK_PAYLOAD_AFTER_ROUND_TRIP,
              llm_model: 'gpt-realtime',
            },
          },
        },
      });

      // …and reading it back returns the same enveloped shape, so get → update → get is stable.
      const reread = (write.json as Json).agent as Json;
      expect(String(reread.conversation_config.agent.language)).toContain('<untrusted-content source=');
    });

    it('update_agent unwraps an advanced_config fragment copied wholesale from get_agent', async () => {
      const { handler, captured } = createUpdateAgentCapturingHandler();
      mswServer.use(handler, ...createElevenLabsAgentsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const read = await testClient.callTool('get_agent', { agent_id: 'agent_test_123' });
      const agent = (read.json as Json).agent as Json;

      const write = await testClient.callTool('update_agent', {
        agent_id: 'agent_test_123',
        advanced_config: { conversation_config: agent.conversation_config },
      });

      expect(write.isError).toBeFalsy();
      const body = captured.body as Json;
      expect(body.conversation_config.agent.language).toBe('en');
      expect(body.conversation_config.agent.prompt.llm_model).toBe('gpt-realtime');
      expect(body.conversation_config.agent.prompt.temperature).toBe(0.4);
      expect(body.conversation_config.agent.prompt.knowledge_base_document_ids).toEqual(['doc_test_123']);
      expect(body.conversation_config.tts.voice_id).toBe('voice_test_123');
      expect(JSON.stringify(body)).not.toContain('<untrusted-content source=');
    });

    it('duplicate_agent and simulate_conversation strip envelopes from copied text too', async () => {
      const duplicate = createDuplicateAgentCapturingHandler();
      const simulate = createSimulateConversationCapturingHandler();
      mswServer.use(duplicate.handler, simulate.handler, ...createElevenLabsAgentsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const read = await testClient.callTool('get_agent', { agent_id: 'agent_test_123' });
      const agent = (read.json as Json).agent as Json;

      await testClient.callTool('duplicate_agent', { agent_id: 'agent_test_123', name: agent.name });
      expect(duplicate.captured.body).toEqual({ name: CLOSE_TAG_AGENT_NAME });

      await testClient.callTool('simulate_conversation', {
        agent_id: 'agent_test_123',
        user_message: 'Reschedule my appointment.',
        language: agent.conversation_config.agent.language,
      });
      expect((simulate.captured.body as Json).simulation_specification.simulated_user_config.language).toBe('en');
    });

    it('keeps hostile prose in a config-shaped field enveloped on the way out', async () => {
      const { handler, captured } = createUpdateAgentCapturingHandler();
      mswServer.use(handler, ...createElevenLabsAgentsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('update_agent', {
        agent_id: 'agent_test_123',
        language: ATTACK_PAYLOAD,
      });

      // Input side: raw text is forwarded verbatim — unwrapping never invents an envelope.
      expect((captured.body as Json).conversation_config.agent.language).toBe(ATTACK_PAYLOAD);

      // Output side: `language` buys no allowlist exemption. This is why the fix is
      // input-side unwrapping rather than widening the literal-string key set.
      const returned = String(((result.json as Json).agent as Json).conversation_config.agent.language);
      expect(returned).toContain('<untrusted-content source=');
      expect(returned).toContain('XINJECTX');
      expect(returned.match(/<\/untrusted-content>/gi) ?? []).toHaveLength(1);
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
