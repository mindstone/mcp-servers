import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import type { ApiCatalog } from '../src/api-catalog.js';
import { mswServer } from './helpers/setup.js';

afterEach(() => {
  vi.doUnmock('../src/generated/api-catalog.js');
  vi.resetModules();
});

describe('family fallback without a same-route read or usable follow-up', () => {
  it('lets only reviewed rows override an unavailable lookup reason with an admitted read', async () => {
    const { apiCatalog } = await vi.importActual<{ apiCatalog: ApiCatalog }>('../src/generated/api-catalog.js');
    const reads = apiCatalog.operations.filter(op => op.profile === 'read');
    const params = (path: string) => [...path.matchAll(/\{([^{}]+)\}/g)].map(([, name]) => name);
    const overridden = apiCatalog.operations.filter(op => op.profile !== 'read' && typeof op.check_before_retry === 'object' && (
      reads.some(read => read.path === op.path) ||
      op.follow_ups.some(id => { const read = reads.find(r => r.operation_id === id); return read && params(read.path).every(name => op.path.includes(`{${name}}`)); })
    )).map(op => op.operation_id).sort();
    // A new read on the same route as a paid job must not silently replace its reviewed "no verifiable lookup" decision.
    // Families with an admitted lookup (pronunciation dictionaries, audio isolation) name it directly, so their rows are not overrides.
    expect(overridden).toEqual(['add_pvc_voice_samples', 'add_sharing_voice', 'add_voice_to_user_voice_collection', 'create_finetune', 'create_or_update_user_voice_collection', 'delete_finetune', 'delete_pvc_voice_sample', 'delete_sample', 'delete_transcript_by_id', 'delete_user_voice_collection', 'delete_voice', 'edit_pvc_voice', 'edit_pvc_voice_sample', 'edit_voice', 'edit_voice_settings', 'remove_voice_from_user_voice_collection', 'request_pvc_manual_verification', 'run_pvc_voice_training', 'speech_to_speech_stream', 'start_speaker_separation', 'text_to_dialogue_stream', 'text_to_speech_stream', 'update_finetune', 'update_user_voice_collection']);
  });
  it('reports unavailable verification honestly without issuing a read or retry', async () => {
    vi.resetModules();
    const actual = await vi.importActual<{ apiCatalog: ApiCatalog }>('../src/generated/api-catalog.js');
    const raw = structuredClone(actual.apiCatalog);
    const op = raw.operations.find(op => op.operation_id === 'create_agent_route')!;
    Object.assign(op, { check_before_retry: { unavailable_reason: 'This family has no reliable result lookup.' }, follow_ups: [] });
    vi.doMock('../src/generated/api-catalog.js', () => ({ apiCatalog: raw }));
    const { setApiKey } = await import('../src/auth.js');
    const { executeApiOperation } = await import('../src/api-executor.js');
    setApiKey('synthetic-retry-key');
    let requests = 0;
    mswServer.use(http.all('https://api.elevenlabs.io/*', () => { requests++; return new HttpResponse(null, { status: 503 }); }));
    try {
      await expect(executeApiOperation('create', { operation_id: op.operation_id, body: { conversation_config: {} } })).rejects.toMatchObject({
        code: 'HTTP_503', resolution: expect.stringContaining('No verifiable lookup: This family has no reliable result lookup.'),
      });
      expect(requests).toBe(1);
    } finally { setApiKey(''); }
  });
  it.each([
    ['agents', 'get_agents_route'], ['llm', 'list_available_llms'],
    ['tools', 'get_tools_route'], ['knowledge-base', 'get_knowledge_base_list_route'],
    ['agent-testing', 'list_chat_response_tests_route'], ['test-invocations', 'list_test_invocations_route'],
    ['tags', 'list_conversation_tags_route'], ['analysis-items', 'list_analysis_items_route'],
    ['settings', 'get_settings_route'], ['environments', 'list_environments'],
    ['analytics', 'get_live_count'], ['users', 'get_conversation_users_route'],
    ['agent', 'get_agents_route'], ['llm-usage', 'list_available_llms'],
  ])('%s uses its policy read %s once, without retrying', async (family, read) => {
    vi.resetModules();
    const actual = await vi.importActual<{ apiCatalog: unknown }>('../src/generated/api-catalog.js');
    const raw = structuredClone(actual.apiCatalog) as ApiCatalog;
    const source = raw.operations.find(op => op.family === family && op.profile !== 'tests')!;
    const op = {
      ...source, operation_id: 'retry_case', path: '/v1/convai/retry-case', method: 'POST' as const,
      profile: 'create' as const, tool: 'elevenlabs_create_resource',
      effects: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      parameters: { path: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const },
        query: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const }, query_serialization: {} },
      request: { media_type: null, required: false }, responses: [{ status: 200, media_type: null }],
      pagination: null, follow_ups: [], examples: [],
    };
    delete op.reviewed_post_read;
    delete op.sensitive_request_fields; // The synthetic bodyless operation has no credential operands.
    raw.operations.push(op);
    vi.doMock('../src/generated/api-catalog.js', () => ({ apiCatalog: raw }));
    const { setApiKey } = await import('../src/auth.js');
    const { createServer } = await import('../src/server.js');
    setApiKey('synthetic-retry-key');
    let requests = 0;
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/retry-case', () => {
      requests++;
      return HttpResponse.json({ detail: 'Unavailable' }, { status: 503 });
    }));
    const pair = await createInMemoryTestClient({ createServer });
    try {
      const result = await pair.callTool('elevenlabs_create_resource', { operation_id: 'retry_case' });
      expect(result.json).toMatchObject({ code: 'HTTP_503', resolution: `The provider reported a server error. Check the result with ${read} through elevenlabs_read_resource before retrying. Use known IDs, or list first to find missing IDs. Check provider availability. No automatic retry was made.` });
      expect(requests).toBe(1);
    } finally { await pair.close(); setApiKey(''); }
  });
});
