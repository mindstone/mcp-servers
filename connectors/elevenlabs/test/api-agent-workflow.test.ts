import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import { mswServer } from './helpers/setup.js';

const tools = { read: 'elevenlabs_read_resource', create: 'elevenlabs_create_resource', change: 'elevenlabs_change_resource', delete: 'elevenlabs_delete_resource', tests: 'elevenlabs_run_agent_tests', query: 'elevenlabs_query_knowledge' } as const;
const access = { is_creator: true, creator_name: 'Jane Example', creator_email: 'jane@example.com', role: 'admin' };
const metadata = { created_at_unix_secs: 1, updated_at_unix_secs: 2 };
const priorLocator = { type: 'text', name: 'Existing guide', id: 'doc_existing', usage_mode: 'prompt' };
const agent = { agent_id: 'agent_example', name: 'Acme guide', conversation_config: { agent: { prompt: { knowledge_base: [priorLocator] } } }, metadata };
const doc = { id: 'doc_uploaded', name: 'Pricing', type: 'file', filename: 'pricing.pdf', metadata: { created_at_unix_secs: 1, last_updated_at_unix_secs: 2, size_bytes: 10 }, supported_usages: [], access_info: access, extracted_inner_html: '<p>Acme prices</p>' };

interface Step {
  method: string; path: string; query?: [string, string][]; body?: unknown;
  form?: { scalars: [string, string][]; name: string; mime: string; bytes: number[] };
  response: unknown; status?: number;
}
let pair: McpTestClient;
let workspace: string;
let requests: number;
const countRequest = () => { requests++; };
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-workflow-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  setApiKey('synthetic-workflow-key');
  pair = await createInMemoryTestClient({ createServer });
  requests = 0;
  mswServer.events.on('request:start', countRequest);
});
afterEach(async () => {
  await pair?.close();
  mswServer.events.removeListener('request:start', countRequest);
  setApiKey('');
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function wireSequence(steps: Step[]) {
  let index = 0;
  mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
    const step = steps[index++];
    expect(step, 'No implicit reads, retries, polling, merges or cleanup requests').toBeDefined();
    const url = new URL(request.url);
    expect({ method: request.method, path: url.pathname, query: [...url.searchParams] })
      .toEqual({ method: step.method, path: step.path, query: step.query ?? [] });
    if (step.form) {
      const form = await request.formData();
      expect([...form.keys()]).toEqual([...step.form.scalars.map(([key]) => key), 'file']);
      for (const [key, value] of step.form.scalars) expect(form.getAll(key)).toEqual([value]);
      const file = form.get('file') as File;
      expect({ name: file.name, mime: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())] })
        .toEqual({ name: step.form.name, mime: step.form.mime, bytes: step.form.bytes });
    } else if (step.body === undefined) expect(await request.text()).toBe('');
    else expect(await request.json()).toEqual(step.body);
    return step.status === 204 ? new HttpResponse(null, { status: 204 }) : HttpResponse.json(step.response, { status: step.status ?? 200 });
  }));
  return () => { expect(index).toBe(steps.length); expect(requests).toBe(steps.length); };
}
async function run(profile: keyof typeof tools, operation_id: string, args: Record<string, unknown> = {}) {
  const before = requests;
  const original = structuredClone(args);
  const result = await pair.callTool(tools[profile], { operation_id, ...args });
  expect(result.isError, result.text).not.toBe(true);
  expect(requests).toBe(before + 1);
  expect(args).toEqual(original);
  const receipt = result.json as Record<string, unknown>;
  expect(receipt).toMatchObject({ ok: true, operation_id, response_contract: 'matched' });
  const data = receipt.data === null ? null : JSON.parse(unwrapUntrusted(String(receipt.data))) as Record<string, unknown>;
  return { data, receipt };
}

it('creates a voice/LLM agent, creates a webhook and explicitly preserves tool IDs when attaching it', async () => {
  const complete = wireSequence([
    { method: 'POST', path: '/v1/convai/agents/create', body: { name: 'Acme guide', conversation_config: { agent: { prompt: { llm: 'gemini-3.5-flash', prompt: 'Answer about the guide.' } }, tts: { voice_id: 'voice_example' } } }, response: { agent_id: 'agent_example' } },
    { method: 'POST', path: '/v1/convai/tools', body: { tool_config: { type: 'webhook', name: 'lookup_guide', description: 'Look up guide entries.', api_schema: { url: 'https://api.example.com/guide', method: 'POST', request_body_schema: { type: 'object', properties: { llm_model: { type: 'string' }, entries: { type: 'array', items: { type: 'object', properties: { active: { type: 'boolean', constant_value: true } } } } } } } }, response_mocks: [{ mock_result: '{"entries":[]}', parameter_conditions: [], is_error: false }] }, response: { id: 'tool_new', tool_config: { type: 'webhook', name: 'lookup_guide', description: 'Look up guide entries.', api_schema: { url: 'https://api.example.com/guide', method: 'POST' } }, access_info: access, usage_stats: { avg_latency_secs: 0 } } },
    { method: 'PATCH', path: '/v1/convai/agents/agent_example', body: { conversation_config: { agent: { prompt: { tool_ids: ['tool_existing', 'tool_new'] } } } }, response: agent },
    { method: 'POST', path: '/v1/convai/knowledge-base/text', body: { name: 'Guide', text: 'Acme guide text.' }, response: { id: 'doc_text', name: 'Guide' } },
  ]);
  const created = await run('create', 'create_agent_route', { body: { name: 'Acme guide', conversation_config: { agent: { prompt: { llm: 'gemini-3.5-flash', prompt: 'Answer about the guide.' } }, tts: { voice_id: 'voice_example' } } } });
  const added = await run('create', 'add_tool_route', { body: { tool_config: { type: 'webhook', name: 'lookup_guide', description: 'Look up guide entries.', api_schema: { url: 'https://api.example.com/guide', method: 'POST', request_body_schema: { type: 'object', properties: { llm_model: { type: 'string' }, entries: { type: 'array', items: { type: 'object', properties: { active: { type: 'boolean', constant_value: true } } } } } } } }, response_mocks: [{ mock_result: '{"entries":[]}', parameter_conditions: [], is_error: false }] } });
  await run('change', 'patch_agent_settings_route', { path_params: { agent_id: created.data!.agent_id }, body: { conversation_config: { agent: { prompt: { tool_ids: ['tool_existing', added.data!.id] } } } } });
  await run('create', 'create_text_document_route', { body: { name: 'Guide', text: 'Acme guide text.' } });
  complete();
});

it.each(['file', 'url'] as const)('replaces deprecated upload with explicit %s creation/get/attachment, retaining pre-attached structured locators', async kind => {
  const filePath = path.join(workspace, 'pricing.pdf');
  fs.writeFileSync(filePath, Buffer.from([37, 80, 68, 70, 0, 255]));
  const createdDoc = kind === 'file' ? doc : { ...doc, id: 'doc_url', type: 'url', url: 'https://docs.example.com/prices' };
  const complete = wireSequence([
    kind === 'file'
      ? { method: 'POST', path: '/v1/convai/knowledge-base/file', form: { scalars: [], name: 'pricing.pdf', mime: 'application/pdf', bytes: [37, 80, 68, 70, 0, 255] }, response: { id: 'doc_uploaded', name: 'Pricing' } }
      : { method: 'POST', path: '/v1/convai/knowledge-base/url', body: { url: 'https://docs.example.com/prices', name: 'Pricing' }, response: { id: 'doc_url', name: 'Pricing' } },
    { method: 'GET', path: kind === 'file' ? '/v1/convai/knowledge-base/doc_uploaded' : '/v1/convai/knowledge-base/doc_url', response: createdDoc },
    { method: 'GET', path: '/v1/convai/agents/agent_example', response: agent },
    { method: 'PATCH', path: '/v1/convai/agents/agent_example', body: { conversation_config: { agent: { prompt: { knowledge_base: [
      { type: 'text', name: 'Existing guide', id: 'doc_existing', usage_mode: 'prompt' },
      { type: kind, name: 'Pricing', id: kind === 'file' ? 'doc_uploaded' : 'doc_url' },
    ] } } } }, response: agent },
  ]);
  const created = kind === 'file'
    ? await run('create', 'create_file_document_route', { files: [{ field: 'file', file_path: filePath }] })
    : await run('create', 'create_url_document_route', { body: { url: 'https://docs.example.com/prices', name: 'Pricing' } });
  const uploaded = await run('read', 'get_documentation_from_knowledge_base', { path_params: { documentation_id: created.data!.id } });
  const existing = await run('read', 'get_agent_route', { path_params: { agent_id: 'agent_example' } });
  const config = existing.data!.conversation_config as { agent: { prompt: { knowledge_base: unknown[] } } };
  const callerAuthored = { conversation_config: { agent: { prompt: { knowledge_base: [
    ...config.agent.prompt.knowledge_base,
    { type: uploaded.data!.type, name: uploaded.data!.name, id: uploaded.data!.id },
  ] } } } };
  await run('change', 'patch_agent_settings_route', { path_params: { agent_id: 'agent_example' }, body: callerAuthored });
  expect(config.agent.prompt.knowledge_base).toEqual([priorLocator]);
  complete();
});

it('creates and inspects explicitly mocked saved Tests, runs once, reads, cancels and resubmits only on caller requests', async () => {
  const complete = wireSequence([
    { method: 'POST', path: '/v1/convai/agent-testing/create', body: { type: 'simulation', name: 'Guide safe mock', simulation_scenario: 'Ask for opening hours.', success_conditions: ['Answers from the guide.'], tool_mock_config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' }, tool_mock_overrides: { tool_example: [{ mock_result: '{"hours":"9-5"}', parameter_conditions: [], is_error: false }] } }, response: { id: 'test_example' } },
    { method: 'GET', path: '/v1/convai/agent-testing/test_example', response: { id: 'test_example', name: 'Guide safe mock', type: 'simulation', tool_mock_config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' }, tool_mock_overrides: { tool_example: [{ mock_result: '{"hours":"9-5"}', parameter_conditions: [], is_error: false }] } } },
    { method: 'POST', path: '/v1/convai/agents/agent_example/run-tests', body: { tests: [{ test_id: 'test_example' }], repeat_count: 1 }, response: { id: 'invocation_example', test_runs: [] } },
    { method: 'GET', path: '/v1/convai/test-invocations/invocation_example', response: { id: 'invocation_example', test_runs: [] } },
    { method: 'POST', path: '/v1/convai/test-invocations/invocation_example/cancel', response: null, status: 204 },
    { method: 'POST', path: '/v1/convai/test-invocations/invocation_example/resubmit', body: { agent_id: 'agent_example', test_run_ids: ['run_example'], agent_config_override: null }, response: {} },
  ]);
  const created = await run('create', 'create_agent_response_test_route', { body: { type: 'simulation', name: 'Guide safe mock', simulation_scenario: 'Ask for opening hours.', success_conditions: ['Answers from the guide.'], tool_mock_config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' }, tool_mock_overrides: { tool_example: [{ mock_result: '{"hours":"9-5"}', parameter_conditions: [], is_error: false }] } } });
  const saved = await run('read', 'get_agent_response_test_route', { path_params: { test_id: created.data!.id } });
  expect(saved.data!.tool_mock_config).toEqual({ mocking_strategy: 'all', fallback_strategy: 'raise_error' });
  const invoked = await run('tests', 'run_agent_test_suite_route', { path_params: { agent_id: 'agent_example' }, body: { tests: [{ test_id: saved.data!.id }], repeat_count: 1 } });
  await run('read', 'get_test_invocation_route', { path_params: { test_invocation_id: invoked.data!.id } });
  const cancelled = await run('tests', 'cancel_test_invocation_route', { path_params: { test_invocation_id: invoked.data!.id } });
  expect(cancelled.receipt).toMatchObject({ status: 204, data: null, effects: { destructiveHint: true } });
  await run('tests', 'resubmit_tests_route', { path_params: { test_invocation_id: invoked.data!.id }, body: { agent_id: 'agent_example', test_run_ids: ['run_example'], agent_config_override: null } });
  complete();
});

it('separates lifecycle deletions and paid read-only RAG from ordinary reads and edits', async () => {
  const complete = wireSequence([
    { method: 'POST', path: '/v1/convai/agents/agent_example/knowledge-base/rag-query', body: { query: 'opening hours', strategy: 'semantic' }, response: { strategy: 'semantic', retrieval_query: 'opening hours', chunks: [] } },
    { method: 'DELETE', path: '/v1/convai/knowledge-base/doc_example', query: [['force', 'false']], response: {} },
    { method: 'DELETE', path: '/v1/convai/tools/tool_example', query: [['force', 'false']], response: {} },
    { method: 'DELETE', path: '/v1/convai/agent-testing/test_example', response: {} },
    { method: 'DELETE', path: '/v1/convai/agents/agent_example', query: [['force', 'false']], response: null, status: 204 },
  ]);
  const refused = await pair.callTool(tools.read, { operation_id: 'query_agent_knowledge_base_rag_route' });
  expect(refused.json).toMatchObject({ code: 'WRONG_TOOL', resolution: expect.stringContaining('elevenlabs_query_knowledge') });
  expect(requests).toBe(0);
  const query = await run('query', 'query_agent_knowledge_base_rag_route', { path_params: { agent_id: 'agent_example' }, body: { query: 'opening hours', strategy: 'semantic' } });
  expect(query.receipt.effects).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  for (const [id, path_params] of [
    ['delete_knowledge_base_document', { documentation_id: 'doc_example' }],
    ['delete_tool_route', { tool_id: 'tool_example' }],
    ['delete_chat_response_test_route', { test_id: 'test_example' }],
    ['delete_agent_route', { agent_id: 'agent_example' }],
  ] as const) {
    const refusal = await pair.callTool(tools.change, { operation_id: id });
    expect(refusal.json).toMatchObject({ code: 'WRONG_TOOL' });
    const deleted = await run('delete', id, { path_params, ...(id === 'delete_chat_response_test_route' ? {} : { query_params: { force: false } }) });
    expect(deleted.receipt.effects).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  }
  complete();
});
