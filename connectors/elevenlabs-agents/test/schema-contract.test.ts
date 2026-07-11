import { describe, it, expect, afterEach } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';

function getTool(tools: Awaited<ReturnType<McpTestClient['client']['listTools']>>['tools'], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool, `Expected tool ${name} to be registered`).toBeDefined();
  return tool!;
}

function getProperties(tool: { inputSchema?: { properties?: Record<string, unknown> } }): string[] {
  return Object.keys(tool.inputSchema?.properties ?? {});
}

function getRequired(tool: { inputSchema?: { required?: string[] } }): string[] {
  return tool.inputSchema?.required ?? [];
}

describe('schema contract', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
  });

  it('exposes the expected JSON-schema properties for the repaired tools', async () => {
    testClient = await createInMemoryTestClient({ createServer });
    const toolsResult = await testClient.client.listTools();

    const updateAgent = getTool(toolsResult.tools, 'update_agent');
    expect(getProperties(updateAgent)).toEqual(expect.arrayContaining([
      'agent_id',
      'name',
      'system_prompt',
      'first_message',
      'voice_id',
      'language',
      'llm_model',
      'temperature',
      'knowledge_base_document_ids',
      'advanced_config',
    ]));
    expect(getRequired(updateAgent)).toContain('agent_id');

    const updatePhoneNumber = getTool(toolsResult.tools, 'update_phone_number');
    expect(getProperties(updatePhoneNumber)).toEqual(expect.arrayContaining([
      'phone_number_id',
      'label',
      'agent_id',
    ]));
    expect(getRequired(updatePhoneNumber)).toContain('phone_number_id');

    const addKnowledgeBaseDocument = getTool(toolsResult.tools, 'add_knowledge_base_document');
    expect(getProperties(addKnowledgeBaseDocument)).toEqual(expect.arrayContaining([
      'name',
      'text',
      'file_path',
      'url',
    ]));

    const makeOutboundCall = getTool(toolsResult.tools, 'make_outbound_call');
    expect(getProperties(makeOutboundCall)).toEqual(expect.arrayContaining([
      'agent_id',
      'phone_number_id',
      'to_number',
    ]));
    expect(getRequired(makeOutboundCall)).toEqual(expect.arrayContaining([
      'agent_id',
      'phone_number_id',
      'to_number',
    ]));
  });

  it('does not expose an empty properties object for any write-side tool schema', async () => {
    testClient = await createInMemoryTestClient({ createServer });
    const toolsResult = await testClient.client.listTools();

    const writeTools = toolsResult.tools.filter((tool) => tool.annotations?.readOnlyHint === false);
    expect(writeTools.length).toBeGreaterThan(0);

    for (const tool of writeTools) {
      expect(
        Object.keys(tool.inputSchema?.properties ?? {}),
        `${tool.name} should expose at least one input property`,
      ).not.toHaveLength(0);
    }
  });
});
