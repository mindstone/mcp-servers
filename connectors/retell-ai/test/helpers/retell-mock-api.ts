import { http, HttpResponse } from 'msw';

const RETELL_API_BASE = 'https://api.retellai.com';

/** Valid mock API key for tests. */
export const MOCK_API_KEY = 'mcp-test-retell-mock-key-0000000001';

const mockAgent = {
  agent_id: 'agent_test_123',
  agent_name: 'Test Agent',
  voice_id: 'voice_test_456',
  language: 'en-US',
  response_engine: { type: 'retell-llm', llm_id: 'llm_test_789' },
  created_at: '2024-01-01T00:00:00Z',
  last_modification_timestamp: 1704067200000,
};

const mockCall = {
  call_id: 'call_test_abc',
  call_type: 'phone_call',
  agent_id: 'agent_test_123',
  status: 'ended',
  start_timestamp: 1704067200000,
  end_timestamp: 1704067260000,
  duration_ms: 60000,
  transcript: 'Hello, this is a test call.',
};

const mockLlm = {
  llm_id: 'llm_test_789',
  general_prompt: 'You are a helpful assistant.',
  begin_message: 'Hello, how can I help you today?',
  model: 'gpt-4o',
  created_at: '2024-01-01T00:00:00Z',
};

const mockVoice = {
  voice_id: 'voice_test_456',
  voice_name: 'Sarah',
  provider: 'elevenlabs',
  accent: 'american',
  gender: 'female',
  age: 'young',
  preview_audio_url: 'https://example.com/preview.mp3',
};

const mockPhoneNumber = {
  phone_number: '+14155551234',
  phone_number_pretty: '(415) 555-1234',
  nickname: 'Main Line',
  inbound_agents: [{ agent_id: 'agent_test_123', agent_version: 1, weight: 1 }],
  outbound_agents: [{ agent_id: 'agent_test_123', agent_version: 1, weight: 1 }],
};

const mockAgentVersion = {
  agent_id: 'agent_test_123',
  version: 1,
  is_published: true,
  last_modification_timestamp: 1704067200000,
};

const mockKnowledgeBase = {
  knowledge_base_id: 'kb_test_123',
  knowledge_base_name: 'Support FAQ',
  status: 'complete',
  max_chunk_size: 2000,
  min_chunk_size: 400,
  knowledge_base_sources: [
    { type: 'text', source_id: 'src_text_1', title: 'Refund policy', content_url: 'https://example.com/stored/refund.txt' },
    { type: 'url', source_id: 'src_url_1', url: 'https://example.com/faq' },
    { type: 'document', source_id: 'src_doc_1', filename: 'policy.pdf', file_url: 'https://example.com/stored/policy.pdf', file_size: 12345 },
  ],
  enable_auto_refresh: false,
};

function requireAuth(authHeader: string | null): HttpResponse | null {
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== MOCK_API_KEY) {
    return HttpResponse.json(
      { error_message: 'Invalid API key provided' },
      { status: 401 },
    );
  }
  return null;
}

export function createRetellHandlers() {
  return [
    // --- Agents ---
    http.post(`${RETELL_API_BASE}/v2/list-agents`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json({
        items: [{
          agent_id: mockAgent.agent_id,
          agent_name: mockAgent.agent_name,
          channel: 'voice',
          response_engine_type: 'retell-llm',
          voice_id: mockAgent.voice_id,
          voice_name: 'Sarah',
          user_modified_timestamp: mockAgent.last_modification_timestamp,
          tags: {},
        }],
        has_more: false,
        pagination_key: 'page_2',
      });
    }),

    http.get(`${RETELL_API_BASE}/get-agent/:agentId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      if (params.agentId === 'nonexistent') {
        return HttpResponse.json({ error_message: 'Agent not found' }, { status: 404 });
      }
      if (params.agentId === 'trigger-500') {
        return HttpResponse.json({ error_message: 'Internal server error' }, { status: 500 });
      }
      return HttpResponse.json({ ...mockAgent, agent_id: params.agentId });
    }),

    http.post(`${RETELL_API_BASE}/create-agent`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...mockAgent,
        agent_id: 'agent_new_001',
        ...(body.agent_name ? { agent_name: body.agent_name } : {}),
        ...(body.voice_id ? { voice_id: body.voice_id } : {}),
        ...(body.language ? { language: body.language } : {}),
      });
    }),

    http.patch(`${RETELL_API_BASE}/update-agent/:agentId`, async ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...mockAgent,
        agent_id: params.agentId,
        ...body,
      });
    }),

    http.post(`${RETELL_API_BASE}/publish-agent-version/:agentId`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${RETELL_API_BASE}/get-agent-versions/:agentId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([{ ...mockAgentVersion, agent_id: params.agentId }]);
    }),

    http.delete(`${RETELL_API_BASE}/delete-agent/:agentId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      if (params.agentId === 'nonexistent') {
        return HttpResponse.json({ error_message: 'Agent not found' }, { status: 404 });
      }
      return new HttpResponse(null, { status: 204 });
    }),

    http.delete(`${RETELL_API_BASE}/delete-retell-llm/:llmId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      if (params.llmId === 'nonexistent') {
        return HttpResponse.json({ error_message: 'Retell LLM not found' }, { status: 404 });
      }
      return new HttpResponse(null, { status: 204 });
    }),

    http.delete(`${RETELL_API_BASE}/delete-phone-number/:phoneNumber`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const phoneNumber = decodeURIComponent(params.phoneNumber as string);
      if (phoneNumber === '+19999999999') {
        return HttpResponse.json({ error_message: 'Phone number not found' }, { status: 404 });
      }
      return new HttpResponse(null, { status: 204 });
    }),

    // --- Calls (v2/v3) ---
    http.post(`${RETELL_API_BASE}/v2/create-phone-call`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...mockCall,
        call_id: 'call_phone_001',
        status: 'registered',
        from_number: body.from_number,
        to_number: body.to_number,
      });
    }),

    http.post(`${RETELL_API_BASE}/v2/create-web-call`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        call_id: 'call_web_001',
        web_call_link: 'https://app.retellai.com/call/call_web_001',
        access_token: 'tok_test',
        agent_id: body.agent_id,
        status: 'registered',
      });
    }),

    http.get(`${RETELL_API_BASE}/v2/get-call/:callId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      if (params.callId === 'nonexistent') {
        return HttpResponse.json({ error_message: 'Call not found' }, { status: 404 });
      }
      return HttpResponse.json({ ...mockCall, call_id: params.callId });
    }),

    http.post(`${RETELL_API_BASE}/v3/list-calls`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([mockCall]);
    }),

    http.post(`${RETELL_API_BASE}/v2/stop-call/:callId`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return new HttpResponse(null, { status: 204 });
    }),

    // --- Batch calls ---
    http.post(`${RETELL_API_BASE}/create-batch-call`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = await request.json() as Record<string, unknown>;
      if (body.from_number === '+14155550000') {
        return HttpResponse.json({ error_message: 'Payment required' }, { status: 402 });
      }
      const tasks = Array.isArray(body.tasks) ? body.tasks : [];
      return HttpResponse.json({
        batch_call_id: 'batch_call_test_001',
        name: body.name ?? 'Batch call',
        from_number: body.from_number,
        scheduled_timestamp: body.trigger_timestamp ?? 1704067200000,
        total_task_count: tasks.length,
        ...(body.call_time_window ? { call_time_window: body.call_time_window } : {}),
      });
    }),

    // --- Account ---
    http.get(`${RETELL_API_BASE}/get-concurrency`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json({
        current_concurrency: 2,
        concurrency_limit: 20,
        base_concurrency: 20,
        purchased_concurrency: 0,
        concurrency_purchase_limit: 180,
        remaining_purchase_limit: 180,
        reserved_inbound_concurrency: 0,
        concurrency_burst_enabled: false,
        concurrency_burst_limit: 0,
      });
    }),

    // --- LLMs ---
    http.get(`${RETELL_API_BASE}/v2/list-retell-llms`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([mockLlm]);
    }),

    http.get(`${RETELL_API_BASE}/get-retell-llm/:llmId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json({ ...mockLlm, llm_id: params.llmId });
    }),

    http.post(`${RETELL_API_BASE}/create-retell-llm`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...mockLlm,
        llm_id: 'llm_new_001',
        ...body,
      });
    }),

    http.patch(`${RETELL_API_BASE}/update-retell-llm/:llmId`, async ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...mockLlm,
        llm_id: params.llmId,
        ...body,
      });
    }),

    // --- Discovery ---
    http.get(`${RETELL_API_BASE}/list-voices`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([mockVoice]);
    }),

    // --- Phone numbers ---
    http.get(`${RETELL_API_BASE}/v2/list-phone-numbers`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([mockPhoneNumber]);
    }),

    http.get(`${RETELL_API_BASE}/get-phone-number/:phoneNumber`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const phoneNumber = decodeURIComponent(params.phoneNumber as string);
      return HttpResponse.json({ ...mockPhoneNumber, phone_number: phoneNumber });
    }),

    http.patch(`${RETELL_API_BASE}/update-phone-number/:phoneNumber`, async ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = await request.json() as Record<string, unknown>;
      const phoneNumber = decodeURIComponent(params.phoneNumber as string);
      return HttpResponse.json({ ...mockPhoneNumber, phone_number: phoneNumber, ...body });
    }),

    // --- Knowledge bases ---
    http.get(`${RETELL_API_BASE}/list-knowledge-bases`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([mockKnowledgeBase]);
    }),

    http.get(`${RETELL_API_BASE}/get-knowledge-base/:kbId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      if (params.kbId === 'nonexistent') {
        return HttpResponse.json({ error_message: 'Knowledge base not found' }, { status: 404 });
      }
      return HttpResponse.json({ ...mockKnowledgeBase, knowledge_base_id: params.kbId });
    }),

    http.post(`${RETELL_API_BASE}/create-knowledge-base`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const form = await request.formData();
      const files = form.getAll('knowledge_base_files')
        .map((f) => (f instanceof File ? f.name : String(f)));
      return HttpResponse.json({
        knowledge_base_id: 'kb_new_001',
        knowledge_base_name: form.get('knowledge_base_name'),
        status: 'in_progress',
        uploaded_files: files,
      }, { status: 201 });
    }),

    http.post(`${RETELL_API_BASE}/add-knowledge-base-sources/:kbId`, async ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const form = await request.formData();
      const files = form.getAll('knowledge_base_files')
        .map((f) => (f instanceof File ? f.name : String(f)));
      return HttpResponse.json({
        ...mockKnowledgeBase,
        knowledge_base_id: params.kbId,
        status: 'refreshing_in_progress',
        uploaded_files: files,
      });
    }),

  ];
}
