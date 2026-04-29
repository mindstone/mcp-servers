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
  agent_id: 'agent_test_123',
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
    http.get(`${RETELL_API_BASE}/list-agents`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([mockAgent]);
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

    // --- Calls ---
    http.post(`${RETELL_API_BASE}/create-phone-call`, async ({ request }) => {
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

    http.post(`${RETELL_API_BASE}/create-web-call`, async ({ request }) => {
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

    http.get(`${RETELL_API_BASE}/get-call/:callId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      if (params.callId === 'nonexistent') {
        return HttpResponse.json({ error_message: 'Call not found' }, { status: 404 });
      }
      return HttpResponse.json({ ...mockCall, call_id: params.callId });
    }),

    http.post(`${RETELL_API_BASE}/v2/list-calls`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([mockCall]);
    }),

    // --- LLMs ---
    http.get(`${RETELL_API_BASE}/list-retell-llms`, ({ request }) => {
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

    // --- Discovery (v1 endpoints) ---
    http.get(`${RETELL_API_BASE}/list-voices`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([mockVoice]);
    }),

    http.get(`${RETELL_API_BASE}/list-phone-numbers`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json([mockPhoneNumber]);
    }),

  ];
}
