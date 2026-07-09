import { http, HttpResponse } from 'msw';
import {
  ATTACK_PAYLOAD,
  mockBatchCall,
  mockBatchCallListItem,
  FASTAPI_422_DETAIL,
  MOCK_API_KEY,
  makeFakeAudioBuffer,
  mockAgent,
  mockOutboundCall,
  mockConversation,
  mockKbDoc,
  mockKbDocListItem,
  mockPhoneNumber,
} from '../fixtures/elevenlabs-agents-data.js';

const BASE_V1 = 'https://api.elevenlabs.io/v1';

export {
  ATTACK_PAYLOAD,
  MOCK_API_KEY,
  SENTINEL,
} from '../fixtures/elevenlabs-agents-data.js';

export { makeFakeAudioBuffer };

function requireAuth(header: string | null): HttpResponse | null {
  if (header !== MOCK_API_KEY) {
    return HttpResponse.json(
      { detail: { status: 'invalid_api_key', message: 'Invalid API key provided' } },
      { status: 401 },
    );
  }
  return null;
}

function triggerResponse(trigger: string | null): HttpResponse | null {
  if (trigger === 'trigger-422') {
    return HttpResponse.json({ detail: FASTAPI_422_DETAIL }, { status: 422 });
  }
  if (trigger === 'trigger-429') {
    return HttpResponse.json(
      { detail: { message: 'Rate limit exceeded. Please retry later.' } },
      { status: 429 },
    );
  }
  if (trigger === 'trigger-404') {
    return HttpResponse.json({ detail: { message: 'Resource not found' } }, { status: 404 });
  }
  return null;
}

function listTriggerFromUrl(url: URL): string | null {
  return url.searchParams.get('cursor');
}

function idTrigger(id: string | readonly string[] | undefined): string | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith('trigger-')) return id;
  return null;
}

export function createElevenLabsAgentsHandlers() {
  return [
    http.get(`${BASE_V1}/convai/agents`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const trigger = listTriggerFromUrl(new URL(request.url));
      const triggered = triggerResponse(trigger);
      if (triggered) return triggered;
      return HttpResponse.json({
        agents: [mockAgent],
        next_cursor: 'cursor_agents_2',
      });
    }),

    http.get(`${BASE_V1}/convai/agents/:agentId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.agentId));
      if (triggered) return triggered;
      return HttpResponse.json({ ...mockAgent, agent_id: params.agentId });
    }),

    http.get(`${BASE_V1}/convai/conversations`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const trigger = listTriggerFromUrl(new URL(request.url));
      const triggered = triggerResponse(trigger);
      if (triggered) return triggered;
      return HttpResponse.json({
        conversations: [mockConversation],
        next_cursor: 'cursor_conversations_2',
      });
    }),

    http.get(`${BASE_V1}/convai/conversations/:conversationId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.conversationId));
      if (triggered) return triggered;
      return HttpResponse.json({ ...mockConversation, conversation_id: params.conversationId });
    }),

    http.get(`${BASE_V1}/convai/conversations/:conversationId/audio`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.conversationId));
      if (triggered) return triggered;
      return new HttpResponse(makeFakeAudioBuffer(2048), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    http.get(`${BASE_V1}/convai/phone-numbers`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const trigger = listTriggerFromUrl(new URL(request.url));
      const triggered = triggerResponse(trigger);
      if (triggered) return triggered;
      return HttpResponse.json({
        phone_numbers: [mockPhoneNumber],
        next_cursor: 'cursor_phone_numbers_2',
      });
    }),

    http.get(`${BASE_V1}/convai/phone-numbers/:phoneNumberId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.phoneNumberId));
      if (triggered) return triggered;
      return HttpResponse.json({ ...mockPhoneNumber, phone_number_id: params.phoneNumberId });
    }),

    http.patch(`${BASE_V1}/convai/phone-numbers/:phoneNumberId`, async ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.phoneNumberId));
      if (triggered) return triggered;
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...mockPhoneNumber,
        phone_number_id: params.phoneNumberId,
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.agent_id === 'string' ? { assigned_agent_id: body.agent_id } : {}),
      });
    }),

    http.post(`${BASE_V1}/convai/twilio/outbound-call`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json(mockOutboundCall);
    }),

    http.post(`${BASE_V1}/convai/sip-trunk/outbound-call`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json({ ...mockOutboundCall, provider: 'sip_trunk' });
    }),

    http.post(`${BASE_V1}/convai/batch-calling/submit`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json({ batch_call: mockBatchCall });
    }),

    http.get(`${BASE_V1}/convai/batch-calling/workspace`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const trigger = new URL(request.url).searchParams.get('last_doc');
      const triggered = triggerResponse(trigger);
      if (triggered) return triggered;
      return HttpResponse.json({
        batch_calls: [mockBatchCallListItem],
        last_doc: 'batch_cursor_2',
      });
    }),

    http.get(`${BASE_V1}/convai/batch-calling/:batchId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.batchId));
      if (triggered) return triggered;
      return HttpResponse.json({ ...mockBatchCall, id: params.batchId });
    }),

    http.post(`${BASE_V1}/convai/batch-calling/:batchId/cancel`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.batchId));
      if (triggered) return triggered;
      return HttpResponse.json({ ...mockBatchCall, id: params.batchId, status: 'cancelled' });
    }),

    http.post(`${BASE_V1}/convai/batch-calling/:batchId/retry`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.batchId));
      if (triggered) return triggered;
      return HttpResponse.json({ ...mockBatchCall, id: params.batchId, status: 'queued' });
    }),

    http.get(`${BASE_V1}/convai/knowledge-base`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const trigger = listTriggerFromUrl(new URL(request.url));
      const triggered = triggerResponse(trigger);
      if (triggered) return triggered;
      return HttpResponse.json({
        documents: [mockKbDocListItem],
        next_cursor: 'cursor_docs_2',
        has_more: true,
      });
    }),

    http.get(`${BASE_V1}/convai/knowledge-base/:documentationId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.documentationId));
      if (triggered) return triggered;
      return HttpResponse.json({ ...mockKbDoc, id: params.documentationId });
    }),
  ];
}

/** Returns 401 for every ConvAI endpoint (wrong-key tests). */
export function createElevenLabsAgentsUnauthorizedHandlers() {
  return [
    http.all(`${BASE_V1}/convai/*`, () =>
      HttpResponse.json({ detail: { message: 'Invalid API key' } }, { status: 401 }),
    ),
  ];
}

/** Returns 401 for every ConvAI endpoint with a missing ConvAI permission payload. */
export function createElevenLabsAgentsMissingPermissionHandlers() {
  return [
    http.all(`${BASE_V1}/convai/*`, () =>
      HttpResponse.json(
        { detail: { status: 'missing_permissions', message: 'Missing permissions: convai' } },
        { status: 401 },
      ),
    ),
  ];
}

/** Returns 429 for every ConvAI endpoint. */
export function createElevenLabsAgentsRateLimitHandlers() {
  return [
    http.all(`${BASE_V1}/convai/*`, () =>
      HttpResponse.json({ detail: { message: 'Rate limit exceeded' } }, { status: 429 }),
    ),
  ];
}

/** Returns FastAPI-style 422 detail arrays for every ConvAI endpoint. */
export function createElevenLabsAgents422Handlers() {
  return [
    http.all(`${BASE_V1}/convai/*`, () =>
      HttpResponse.json({ detail: FASTAPI_422_DETAIL }, { status: 422 }),
    ),
  ];
}

export function createUpdatePhoneNumberCapturingHandler(expectedApiKey = MOCK_API_KEY) {
  const captured: { body?: Record<string, unknown> } = {};

  const handler = http.patch(`${BASE_V1}/convai/phone-numbers/:phoneNumberId`, async ({ request, params }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      ...mockPhoneNumber,
      phone_number_id: params.phoneNumberId,
      ...(typeof captured.body.label === 'string' ? { label: captured.body.label } : {}),
      ...(typeof captured.body.agent_id === 'string' ? { assigned_agent_id: captured.body.agent_id } : {}),
    });
  });

  return { handler, captured };
}

export function createOutboundCallCapturingHandler(expectedApiKey = MOCK_API_KEY) {
  const captured: { body?: Record<string, unknown> } = {};

  const handler = http.post(`${BASE_V1}/convai/twilio/outbound-call`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(mockOutboundCall);
  });

  return { handler, captured };
}

export function createSipTrunkOutboundCallCapturingHandler(expectedApiKey = MOCK_API_KEY) {
  const captured: { body?: Record<string, unknown>; endpointHit?: boolean } = {};

  const handler = http.post(`${BASE_V1}/convai/sip-trunk/outbound-call`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.endpointHit = true;
    captured.body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({ ...mockOutboundCall, provider: 'sip_trunk' });
  });

  return { handler, captured };
}

export function createPhoneNumberProviderHandler(
  provider: string | undefined,
  expectedApiKey = MOCK_API_KEY,
) {
  return http.get(`${BASE_V1}/convai/phone-numbers/:phoneNumberId`, ({ request, params }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    const payload = {
      ...mockPhoneNumber,
      phone_number_id: params.phoneNumberId,
      ...(provider === undefined ? { provider: undefined } : { provider }),
    };
    return HttpResponse.json(payload);
  });
}

export function createSubmitBatchCallCapturingHandler(expectedApiKey = MOCK_API_KEY) {
  const captured: { body?: Record<string, unknown> } = {};

  const handler = http.post(`${BASE_V1}/convai/batch-calling/submit`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({ batch_call: mockBatchCall });
  });

  return { handler, captured };
}
