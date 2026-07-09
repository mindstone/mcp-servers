/**
 * `<untrusted-content>` envelope discipline for the ElevenLabs Agents connector.
 * Hostile fixtures per Stage 5 refinement packet:
 * - agent named `</untrusted-content>inject`
 * - transcript turn containing tool-call-like JSON
 * - KB doc >50KB with truncation metadata
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { wrapUntrusted } from '../src/untrusted-content.js';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  ATTACK_PAYLOAD,
  CLOSE_TAG_AGENT_NAME,
  MOCK_API_KEY,
  NESTED_TOOL_CALL_ARGUMENTS_ATTACK,
  OVERSIZED_KB_PADDING,
  SENTINEL,
  TOOL_CALL_TRANSCRIPT_JSON,
} from './fixtures/elevenlabs-agents-data.js';
import { createElevenLabsAgentsHandlers } from './helpers/elevenlabs-agents-mock-server.js';

const ESCAPED_CLOSE_TAG = '<\\/untrusted-content>';

/** Same variant detector as `src/untrusted-content.ts` — whitespace/case-tolerant close-tag breakout. */
const UNTRUSTED_CLOSE_TAG_VARIANT = /<\/untrusted-content[ \t]*>/i;

function rawInputRequiresDefang(rawInput: string): boolean {
  return UNTRUSTED_CLOSE_TAG_VARIANT.test(rawInput);
}

/**
 * Assert envelope shape; require defanged close-tag only when `rawInput` contained a
 * close-tag variant (Stage 5/7 refinement — benign authoring responses like
 * "Updated system prompt" are correctly enveloped without an escaped sentinel).
 */
function expectEnvelopedAndDefanged(value: unknown, source: string, rawInput?: string): void {
  expect(typeof value).toBe('string');
  const text = value as string;
  expect(text).toContain(`<untrusted-content source="${source}">`);
  expect(text.endsWith('</untrusted-content>')).toBe(true);
  if (rawInput !== undefined && rawInputRequiresDefang(rawInput)) {
    expect(text).toContain(ESCAPED_CLOSE_TAG);
  }
  expect(text).not.toContain('</UNTRUSTED-CONTENT');
  expect(text.match(/<\/untrusted-content>/gi) ?? []).toHaveLength(1);
}

function assertSentinelOnlyInsideEnvelopes(value: unknown, jsonPath = '$'): void {
  if (typeof value === 'string') {
    if (value.includes(SENTINEL) || value.includes(CLOSE_TAG_AGENT_NAME) || value.includes(`${ESCAPED_CLOSE_TAG}inject`)) {
      expect(
        /^<untrusted-content source="[^"]*">[\s\S]*<\/untrusted-content>$/.test(value),
        `${jsonPath} contains API-authored text outside an envelope: ${value}`,
      ).toBe(true);
      expect(value.match(/<\/untrusted-content>/gi) ?? [], `${jsonPath} envelope breakout`).toHaveLength(1);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSentinelOnlyInsideEnvelopes(item, `${jsonPath}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertSentinelOnlyInsideEnvelopes(child, `${jsonPath}.${key}`);
    }
  }
}

describe('wrapUntrusted', () => {
  it('wraps and defangs close-tag breakout attempts', () => {
    const wrapped = wrapUntrusted(ATTACK_PAYLOAD, 'elevenlabs-agents:get_conversation:transcript')!;
    expect(wrapped).toContain(ESCAPED_CLOSE_TAG);
    expect(wrapped.endsWith('</untrusted-content>')).toBe(true);
    expect((wrapped.match(/<\/untrusted-content>/gi) ?? [])).toHaveLength(1);
  });

  it('escapes attribute breakout characters in the source label', () => {
    const wrapped = wrapUntrusted('payload', 'elevenlabs-agents:"><script>')!;
    expect(wrapped).toContain('source="elevenlabs-agents:&quot;&gt;&lt;script&gt;"');
    expect(wrapped).not.toContain('<script>');
  });
});

describe('Stage 5 external-text envelope coverage', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('envelopes the hostile close-tag agent name and all prompt surfaces', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listed = await testClient.callTool('list_agents', { page_size: 1 });
    const listedJson = listed.json as Record<string, unknown>;
    const agents = listedJson.agents as Array<Record<string, unknown>>;
    expectEnvelopedAndDefanged(agents[0].name, 'elevenlabs-agents:list_agents:name', CLOSE_TAG_AGENT_NAME);
    expect(String(agents[0].name)).toContain(`${ESCAPED_CLOSE_TAG}inject`);
    const listedPrompt = (
      ((agents[0].conversation_config as Record<string, unknown>).agent as Record<string, unknown>).prompt
    ) as Record<string, unknown>;
    expectEnvelopedAndDefanged(
      listedPrompt.prompt,
      'elevenlabs-agents:list_agents:conversation_config:agent:prompt:prompt',
      ATTACK_PAYLOAD,
    );
    assertSentinelOnlyInsideEnvelopes(listedJson);

    const single = await testClient.callTool('get_agent', { agent_id: 'agent_test_123' });
    const singleJson = single.json as Record<string, unknown>;
    const agent = singleJson.agent as Record<string, unknown>;
    expectEnvelopedAndDefanged(agent.name, 'elevenlabs-agents:get_agent:name', CLOSE_TAG_AGENT_NAME);
    expect(String(agent.name)).toContain(`${ESCAPED_CLOSE_TAG}inject`);
    expectEnvelopedAndDefanged(agent.system_prompt, 'elevenlabs-agents:get_agent:system_prompt', ATTACK_PAYLOAD);
    expectEnvelopedAndDefanged(
      ((agent.conversation_config as Record<string, unknown>).agent as Record<string, unknown>).first_message,
      'elevenlabs-agents:get_agent:conversation_config:agent:first_message',
      ATTACK_PAYLOAD,
    );
    assertSentinelOnlyInsideEnvelopes(singleJson);

    const updated = await testClient.callTool('update_agent', {
      agent_id: 'agent_test_123',
      system_prompt: 'Updated system prompt',
    });
    const updatedJson = updated.json as Record<string, unknown>;
    const updatedAgent = updatedJson.agent as Record<string, unknown>;
    expectEnvelopedAndDefanged(updatedAgent.name, 'elevenlabs-agents:update_agent:name', CLOSE_TAG_AGENT_NAME);
    expectEnvelopedAndDefanged(
      (((updatedAgent.conversation_config as Record<string, unknown>).agent as Record<string, unknown>).prompt as Record<string, unknown>).prompt,
      'elevenlabs-agents:update_agent:conversation_config:agent:prompt:prompt',
      'Updated system prompt',
    );
    assertSentinelOnlyInsideEnvelopes(updatedJson);
  });

  it('envelopes tool-call-like transcript JSON and dynamic variables', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listed = await testClient.callTool('list_conversations', { page_size: 1 });
    const listedJson = listed.json as Record<string, unknown>;
    const conversations = listedJson.conversations as Array<Record<string, unknown>>;
    expectEnvelopedAndDefanged(conversations[0].summary, 'elevenlabs-agents:list_conversations:summary', ATTACK_PAYLOAD);
    const turns = conversations[0].transcript_turns as Array<Record<string, unknown>>;
    expect(turns[0].role).toBe('user');
    expectEnvelopedAndDefanged(turns[0].text, 'elevenlabs-agents:list_conversations:transcript_turns[0]:text', TOOL_CALL_TRANSCRIPT_JSON);
    expect(String(turns[0].text)).toContain('tool_calls');
    expect(String(turns[0].text)).toContain(`${ESCAPED_CLOSE_TAG}inject`);
    expectEnvelopedAndDefanged(
      (((turns[0].tool_calls as Array<Record<string, unknown>>)[0].function as Record<string, unknown>).arguments),
      'elevenlabs-agents:list_conversations:transcript_turns[0]:tool_calls[0]:function:arguments',
      NESTED_TOOL_CALL_ARGUMENTS_ATTACK,
    );
    expectEnvelopedAndDefanged(turns[1].message, 'elevenlabs-agents:list_conversations:transcript_turns[1]:message', ATTACK_PAYLOAD);
    assertSentinelOnlyInsideEnvelopes(listedJson);

    const single = await testClient.callTool('get_conversation', { conversation_id: 'conv_test_123' });
    const singleJson = single.json as Record<string, unknown>;
    const conversation = singleJson.conversation as Record<string, unknown>;
    expectEnvelopedAndDefanged(conversation.transcript, 'elevenlabs-agents:get_conversation:transcript', ATTACK_PAYLOAD);
    expectEnvelopedAndDefanged(
      (conversation.analysis as Record<string, unknown>).call_summary,
      'elevenlabs-agents:get_conversation:analysis',
      ATTACK_PAYLOAD,
    );
    expectEnvelopedAndDefanged(
      (conversation.dynamic_variables as Record<string, unknown>).caller_name,
      'elevenlabs-agents:get_conversation:dynamic_variables',
      ATTACK_PAYLOAD,
    );
    expectEnvelopedAndDefanged(
      (conversation.dynamic_variables as Record<string, unknown>).account_note,
      'elevenlabs-agents:get_conversation:dynamic_variables',
      ATTACK_PAYLOAD,
    );
    const singleTurns = conversation.transcript_turns as Array<Record<string, unknown>>;
    expect(singleTurns[0].role).toBe('user');
    expectEnvelopedAndDefanged(
      (((singleTurns[0].tool_calls as Array<Record<string, unknown>>)[0].function as Record<string, unknown>).arguments),
      'elevenlabs-agents:get_conversation:transcript_turns[0]:tool_calls[0]:function:arguments',
      NESTED_TOOL_CALL_ARGUMENTS_ATTACK,
    );
    assertSentinelOnlyInsideEnvelopes(singleJson);
  });

  it('envelopes phone labels and KB names/content with ~50KB truncation metadata', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listedPhones = await testClient.callTool('list_phone_numbers', { page_size: 1 });
    const listedPhoneJson = listedPhones.json as Record<string, unknown>;
    const phoneNumbers = listedPhoneJson.phone_numbers as Array<Record<string, unknown>>;
    expectEnvelopedAndDefanged(phoneNumbers[0].label, 'elevenlabs-agents:list_phone_numbers:label', ATTACK_PAYLOAD);
    assertSentinelOnlyInsideEnvelopes(listedPhoneJson);

    const phone = await testClient.callTool('get_phone_number', { phone_number_id: 'pn_test_123' });
    const phoneJson = phone.json as Record<string, unknown>;
    expectEnvelopedAndDefanged(
      (phoneJson.phone_number as Record<string, unknown>).label,
      'elevenlabs-agents:get_phone_number:label',
      ATTACK_PAYLOAD,
    );
    assertSentinelOnlyInsideEnvelopes(phoneJson);

    const listedKb = await testClient.callTool('list_knowledge_base_docs', { page_size: 1 });
    const listedKbJson = listedKb.json as Record<string, unknown>;
    const docs = listedKbJson.documents as Array<Record<string, unknown>>;
    expectEnvelopedAndDefanged(docs[0].name, 'elevenlabs-agents:list_knowledge_base_docs:name', ATTACK_PAYLOAD);
    assertSentinelOnlyInsideEnvelopes(listedKbJson);

    const kb = await testClient.callTool('get_knowledge_base_doc', { documentation_id: 'doc_test_123' });
    const kbJson = kb.json as Record<string, unknown>;
    const document = kbJson.document as Record<string, unknown>;
    const kbRawContent = `${ATTACK_PAYLOAD}\n${OVERSIZED_KB_PADDING}`;
    expectEnvelopedAndDefanged(document.name, 'elevenlabs-agents:get_knowledge_base_doc:name', ATTACK_PAYLOAD);
    expectEnvelopedAndDefanged(document.content, 'elevenlabs-agents:get_knowledge_base_doc:content', kbRawContent);
    expect(String(document.content)).toContain(ESCAPED_CLOSE_TAG);
    expect(document.content_truncated).toBe(true);
    expect(document.content_original_bytes).toBeGreaterThan(50_000);
    expect(document.content_returned_bytes).toBeLessThanOrEqual(50_000);
    expect(Buffer.byteLength(OVERSIZED_KB_PADDING, 'utf8')).toBeGreaterThan(50_000);
    assertSentinelOnlyInsideEnvelopes(kbJson);

    const added = await testClient.callTool('add_knowledge_base_document', {
      mode: 'text',
      text: 'Refunds take 3 business days.',
      name: 'Refund policy',
    });
    const addedJson = added.json as Record<string, unknown>;
    expectEnvelopedAndDefanged(
      (addedJson.document as Record<string, unknown>).name,
      'elevenlabs-agents:add_knowledge_base_document:name',
      'Refund policy',
    );
    assertSentinelOnlyInsideEnvelopes(addedJson);
  });

  it('envelopes batch call names, per-recipient failure text, and dynamic variables', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listed = await testClient.callTool('list_batch_calls', { limit: 1 });
    const listedJson = listed.json as Record<string, unknown>;
    const batchCalls = listedJson.batch_calls as Array<Record<string, unknown>>;
    expectEnvelopedAndDefanged(batchCalls[0].call_name, 'elevenlabs-agents:list_batch_calls:call_name', ATTACK_PAYLOAD);
    expectEnvelopedAndDefanged(
      (((batchCalls[0].recipients as Array<Record<string, unknown>>)[0]
        .conversation_initiation_client_data as Record<string, unknown>).dynamic_variables as Record<string, unknown>)
        .customer_name,
      'elevenlabs-agents:list_batch_calls:recipients[0]:conversation_initiation_client_data:dynamic_variables',
      ATTACK_PAYLOAD,
    );
    assertSentinelOnlyInsideEnvelopes(listedJson);

    const single = await testClient.callTool('get_batch_call', { batch_id: 'batch_test_123' });
    const singleJson = single.json as Record<string, unknown>;
    const batchCall = singleJson.batch_call as Record<string, unknown>;
    expectEnvelopedAndDefanged(batchCall.call_name, 'elevenlabs-agents:get_batch_call:call_name', ATTACK_PAYLOAD);
    const recipients = batchCall.recipients as Array<Record<string, unknown>>;
    expectEnvelopedAndDefanged(
      recipients[1].error_message,
      'elevenlabs-agents:get_batch_call:recipients[1]:error_message',
      ATTACK_PAYLOAD,
    );
    expectEnvelopedAndDefanged(
      (((recipients[0].conversation_initiation_client_data as Record<string, unknown>).dynamic_variables as Record<string, unknown>).customer_name),
      'elevenlabs-agents:get_batch_call:recipients[0]:conversation_initiation_client_data:dynamic_variables',
      ATTACK_PAYLOAD,
    );
    assertSentinelOnlyInsideEnvelopes(singleJson);

    const submitted = await testClient.callTool('submit_batch_call', {
      call_name: 'Renewals wave 1',
      agent_id: 'agent_test_123',
      recipients: [{ phone_number: '+14155559876', dynamic_variables: { customer_name: 'Jane' } }],
    });
    const submittedJson = submitted.json as Record<string, unknown>;
    expectEnvelopedAndDefanged(
      ((submittedJson.batch_call as Record<string, unknown>).call_name),
      'elevenlabs-agents:submit_batch_call:call_name',
      'Renewals wave 1',
    );
    assertSentinelOnlyInsideEnvelopes(submittedJson);
  });

  it('envelopes simulated conversation turns and simulation analysis prose', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('simulate_conversation', {
      agent_id: 'agent_test_123',
      user_message: 'I need help rescheduling.',
    });
    const json = result.json as Record<string, unknown>;
    const turns = json.simulated_conversation as Array<Record<string, unknown>>;
    expectEnvelopedAndDefanged(
      turns[0].message,
      'elevenlabs-agents:simulate_conversation:simulated_conversation[0]:message',
      ATTACK_PAYLOAD,
    );
    expectEnvelopedAndDefanged(
      (((turns[0].multivoice_message as Record<string, unknown>).parts as Array<Record<string, unknown>>)[0].text),
      'elevenlabs-agents:simulate_conversation:simulated_conversation[0]:multivoice_message:parts[0]:text',
      ATTACK_PAYLOAD,
    );
    expectEnvelopedAndDefanged(
      turns[0].original_message,
      'elevenlabs-agents:simulate_conversation:simulated_conversation[0]:original_message',
      ATTACK_PAYLOAD,
    );
    expectEnvelopedAndDefanged(
      ((json.analysis as Record<string, unknown>).transcript_summary),
      'elevenlabs-agents:simulate_conversation:analysis:transcript_summary',
      ATTACK_PAYLOAD,
    );
    expectEnvelopedAndDefanged(
      ((json.analysis as Record<string, unknown>).call_summary_title),
      'elevenlabs-agents:simulate_conversation:analysis:call_summary_title',
      ATTACK_PAYLOAD,
    );
    const criteriaResult = (((json.analysis as Record<string, unknown>).evaluation_criteria_results_list as Array<Record<string, unknown>>)[0]);
    expect(criteriaResult.criteria_id).toBe('criteria_test_123');
    expect(criteriaResult.result).toBe('success');
    expectEnvelopedAndDefanged(
      criteriaResult.rationale,
      'elevenlabs-agents:simulate_conversation:analysis:evaluation_criteria_results_list[0]:rationale',
      ATTACK_PAYLOAD,
    );
    const dataCollectionResult = (((json.analysis as Record<string, unknown>).data_collection_results_list as Array<Record<string, unknown>>)[0]);
    expect(dataCollectionResult.data_collection_id).toBe('data_collection_test_123');
    expectEnvelopedAndDefanged(
      dataCollectionResult.rationale,
      'elevenlabs-agents:simulate_conversation:analysis:data_collection_results_list[0]:rationale',
      ATTACK_PAYLOAD,
    );
    expectEnvelopedAndDefanged(
      dataCollectionResult.value,
      'elevenlabs-agents:simulate_conversation:analysis:data_collection_results_list[0]:value',
      ATTACK_PAYLOAD,
    );
    assertSentinelOnlyInsideEnvelopes(json);
  });

  it('downloads conversation audio to a tmp file without leaking hostile transcript text', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_conversation_audio', { conversation_id: 'conv_test_123' });
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.file_path).toBe('string');
    expect(fs.existsSync(parsed.file_path as string)).toBe(true);
    expect(parsed).not.toHaveProperty('transcript');
    expect(String(parsed.message ?? '')).not.toContain('tool_calls');
    if (fs.existsSync(parsed.file_path as string)) fs.unlinkSync(parsed.file_path as string);
  });
});

describe('tool sources reach the envelope helper', () => {
  it('tool modules that surface API-authored text import sanitize.ts and the API error helper wraps detail strings', async () => {
    const nodeFs = await import('node:fs');
    const nodePath = await import('node:path');
    const nodeUrl = await import('node:url');
    const dir = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
    const TOOLS = ['agents.ts', 'batch-calls.ts', 'calls.ts', 'conversations.ts', 'knowledge-base.ts', 'phone-numbers.ts'];

    for (const file of TOOLS) {
      const contents = nodeFs.readFileSync(nodePath.join(dir, '..', 'src', 'tools', file), 'utf8');
      expect(contents, `${file} must import sanitize helpers`).toContain("from '../sanitize.js'");
      expect(contents, `${file} must call sanitize helpers`).toMatch(/sanitize[A-Z]\w*\(/);
    }

    const sanitizeContents = nodeFs.readFileSync(nodePath.join(dir, '..', 'src', 'sanitize.ts'), 'utf8');
    expect(sanitizeContents).toContain("from './untrusted-content.js'");
    expect(sanitizeContents).toMatch(/wrapUntrusted(JsonStrings)?\(/);

    const errorDetail = nodeFs.readFileSync(nodePath.join(dir, '..', 'src', 'error-detail.ts'), 'utf8');
    expect(errorDetail).toContain("from './untrusted-content.js'");
    expect(errorDetail).toMatch(/wrapUntrusted\(/);
  });
});
