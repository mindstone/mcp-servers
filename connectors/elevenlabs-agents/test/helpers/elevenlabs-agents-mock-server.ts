import { http, HttpResponse } from 'msw';
import {
  ATTACK_PAYLOAD,
  mockBatchCall,
  mockBatchCallListItem,
  FASTAPI_422_DETAIL,
  MALFORMED_JSON_RESPONSE_BODY,
  MOCK_API_KEY,
  makeFakeAudioBuffer,
  mockAgent,
  mockConversation,
  mockKbDoc,
  mockKbDocContent,
  mockKbDocListItem,
  mockKbDocUrlMetadata,
  mockOutboundCall,
  mockPhoneNumber,
  mockRagIndex,
  mockSimulation,
} from '../fixtures/elevenlabs-agents-data.js';

const BASE_V1 = 'https://api.elevenlabs.io/v1';

export {
  ATTACK_PAYLOAD,
  MOCK_API_KEY,
  SENTINEL,
} from '../fixtures/elevenlabs-agents-data.js';

export { makeFakeAudioBuffer };

type JsonBody = Record<string, unknown>;

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
  return url.searchParams.get('cursor') ?? url.searchParams.get('last_doc');
}

function idTrigger(id: string | readonly string[] | undefined): string | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith('trigger-')) return id;
  return null;
}

function isObj(value: unknown): value is JsonBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) {
    return patch;
  }

  const out: JsonBody = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

function materializeAgent(agentId: string, patch: JsonBody = {}): JsonBody {
  return deepMerge(
    {
      ...mockAgent,
      agent_id: agentId,
    },
    patch,
  ) as JsonBody;
}

function createdKnowledgeBaseResponse(
  documentationId: string,
  name = 'Created KB document',
): JsonBody {
  return {
    id: documentationId,
    name,
    folder_path: [{ id: 'folder_root' }],
  };
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

    http.post(`${BASE_V1}/convai/agents/create`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json({ agent_id: 'agent_created_123' });
    }),

    http.get(`${BASE_V1}/convai/agents/:agentId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.agentId));
      if (triggered) return triggered;
      return HttpResponse.json(materializeAgent(String(params.agentId)));
    }),

    http.patch(`${BASE_V1}/convai/agents/:agentId`, async ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.agentId));
      if (triggered) return triggered;
      const body = await request.json() as JsonBody;
      return HttpResponse.json(materializeAgent(String(params.agentId), body));
    }),

    http.post(`${BASE_V1}/convai/agents/:agentId/duplicate`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.agentId));
      if (triggered) return triggered;
      return HttpResponse.json({ agent_id: 'agent_duplicate_123' });
    }),

    http.delete(`${BASE_V1}/convai/agents/:agentId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.agentId));
      if (triggered) return triggered;
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${BASE_V1}/convai/agents/:agentId/simulate-conversation`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.agentId));
      if (triggered) return triggered;
      return HttpResponse.json(mockSimulation);
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

    http.post(`${BASE_V1}/convai/conversations/:conversationId/feedback`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.conversationId));
      if (triggered) return triggered;
      return HttpResponse.json({});
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

    http.post(`${BASE_V1}/convai/phone-numbers`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json({ phone_number_id: 'pn_imported_123' });
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
      const body = await request.json() as JsonBody;
      return HttpResponse.json({
        ...mockPhoneNumber,
        phone_number_id: params.phoneNumberId,
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.agent_id === 'string' ? { assigned_agent_id: body.agent_id } : {}),
      });
    }),

    http.delete(`${BASE_V1}/convai/phone-numbers/:phoneNumberId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.phoneNumberId));
      if (triggered) return triggered;
      return new HttpResponse(null, { status: 204 });
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

    http.post(`${BASE_V1}/convai/knowledge-base/text`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const body = await request.json() as JsonBody;
      return HttpResponse.json(
        createdKnowledgeBaseResponse(
          'doc_created_text_123',
          typeof body.name === 'string' ? body.name : 'Created text document',
        ),
      );
    }),

    http.post(`${BASE_V1}/convai/knowledge-base/file`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const formData = await request.formData();
      const name = formData.get('name');
      return HttpResponse.json(
        createdKnowledgeBaseResponse(
          'doc_created_file_123',
          typeof name === 'string' && name.length > 0 ? name : 'Created file document',
        ),
      );
    }),

    http.post(`${BASE_V1}/convai/knowledge-base/url`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const body = await request.json() as JsonBody;
      return HttpResponse.json(
        createdKnowledgeBaseResponse(
          'doc_created_url_123',
          typeof body.name === 'string' ? body.name : 'Created URL document',
        ),
      );
    }),

    http.get(`${BASE_V1}/convai/knowledge-base/:documentationId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.documentationId));
      if (triggered) return triggered;
      if (params.documentationId === 'doc_url_test_123') {
        return HttpResponse.json({ ...mockKbDocUrlMetadata, id: params.documentationId });
      }
      return HttpResponse.json({ ...mockKbDoc, id: params.documentationId });
    }),

    http.get(`${BASE_V1}/convai/knowledge-base/:documentationId/content`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.documentationId));
      if (triggered) return triggered;
      if (params.documentationId === 'trigger-404') {
        return HttpResponse.json({ detail: { message: 'Resource not found' } }, { status: 404 });
      }
      return HttpResponse.text(mockKbDocContent, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }),

    http.delete(`${BASE_V1}/convai/knowledge-base/:documentationId`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.documentationId));
      if (triggered) return triggered;
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${BASE_V1}/convai/knowledge-base/:documentationId/rag-index`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.documentationId));
      if (triggered) return triggered;
      return HttpResponse.json({ indexes: [mockRagIndex] });
    }),

    http.post(`${BASE_V1}/convai/knowledge-base/:documentationId/rag-index`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      const triggered = triggerResponse(idTrigger(params.documentationId));
      if (triggered) return triggered;
      return HttpResponse.json(mockRagIndex);
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

/**
 * Returns a hostile non-JSON body with a JSON content-type and a 200 status for every
 * ConvAI endpoint — the shape that makes `JSON.parse` quote raw response bytes back.
 */
export function createElevenLabsAgentsMalformedJsonHandlers() {
  return [
    http.all(`${BASE_V1}/convai/*`, () =>
      HttpResponse.text(MALFORMED_JSON_RESPONSE_BODY, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  ];
}

/**
 * HTTP-200 bodies that are perfectly *valid* JSON but not the expected object shape:
 * a bare hostile scalar where an object is expected, and list bodies whose items are
 * bare hostile scalars. `elevenLabsJson` parses both without complaint, so whatever
 * the surface sanitizer does with a non-object root is exactly what reaches the model.
 */
export function createElevenLabsAgentsNonObjectRootHandlers() {
  return [
    http.get(`${BASE_V1}/convai/agents`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json({ agents: [ATTACK_PAYLOAD], next_cursor: 'cursor_agents_2' });
    }),

    http.get(`${BASE_V1}/convai/agents/:agentId`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json(ATTACK_PAYLOAD);
    }),

    http.get(`${BASE_V1}/convai/knowledge-base`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json({ documents: [ATTACK_PAYLOAD] });
    }),

    http.get(`${BASE_V1}/convai/knowledge-base/:documentationId`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json(ATTACK_PAYLOAD);
    }),

    http.get(`${BASE_V1}/convai/conversations`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json({ conversations: [ATTACK_PAYLOAD] });
    }),
  ];
}

/**
 * An HTTP-200 simulation body whose `simulated_conversation` is the wrong *shape* — a
 * bare hostile string, or an object — where an array of turns is expected. The body is
 * valid JSON and the response root is a perfectly ordinary object, so the non-object-root
 * guard never fires; whatever the transcript walker does with a non-array is exactly what
 * `simulate_conversation` hands the model.
 */
export function createElevenLabsAgentsMalformedTranscriptHandlers(simulatedConversation: unknown) {
  return [
    http.post(`${BASE_V1}/convai/agents/:agentId/simulate-conversation`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('xi-api-key'));
      if (authErr) return authErr;
      return HttpResponse.json({
        simulated_conversation: simulatedConversation,
        analysis: mockSimulation.analysis,
      } as JsonBody);
    }),
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

export function createUpdatePhoneNumberCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.patch(`${BASE_V1}/convai/phone-numbers/:phoneNumberId`, async ({ request, params }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json({
      ...mockPhoneNumber,
      phone_number_id: params.phoneNumberId,
      ...(typeof captured.body.label === 'string' ? { label: captured.body.label } : {}),
      ...(typeof captured.body.agent_id === 'string' ? { assigned_agent_id: captured.body.agent_id } : {}),
    });
  });

  return { handler, captured };
}

export function createImportPhoneNumberCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/phone-numbers`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json({ phone_number_id: 'pn_imported_123' });
  });

  return { handler, captured };
}

export function createConversationFeedbackCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/conversations/:conversationId/feedback`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json({});
  });

  return { handler, captured };
}

export function createOutboundCallCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/twilio/outbound-call`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json(mockOutboundCall);
  });

  return { handler, captured };
}

export function createSipTrunkOutboundCallCapturingHandler() {
  const captured: { body?: JsonBody; endpointHit?: boolean } = {};

  const handler = http.post(`${BASE_V1}/convai/sip-trunk/outbound-call`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.endpointHit = true;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json({ ...mockOutboundCall, provider: 'sip_trunk' });
  });

  return { handler, captured };
}

export function createPhoneNumberProviderHandler(
  provider: string | undefined,
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

export function createSubmitBatchCallCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/batch-calling/submit`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json({ batch_call: mockBatchCall });
  });

  return { handler, captured };
}

export function createCreateAgentCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/agents/create`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json({ agent_id: 'agent_created_123' });
  });

  return { handler, captured };
}

export function createUpdateAgentCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.patch(`${BASE_V1}/convai/agents/:agentId`, async ({ request, params }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json(materializeAgent(String(params.agentId), captured.body));
  });

  return { handler, captured };
}

export function createDuplicateAgentCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/agents/:agentId/duplicate`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json({ agent_id: 'agent_duplicate_123' });
  });

  return { handler, captured };
}

export function createSimulateConversationCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/agents/:agentId/simulate-conversation`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json(mockSimulation);
  });

  return { handler, captured };
}

export function createKnowledgeBaseTextCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/knowledge-base/text`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json(
      createdKnowledgeBaseResponse(
        'doc_created_text_123',
        typeof captured.body.name === 'string' ? captured.body.name : 'Created text document',
      ),
    );
  });

  return { handler, captured };
}

export function createKnowledgeBaseUrlCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/knowledge-base/url`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json(
      createdKnowledgeBaseResponse(
        'doc_created_url_123',
        typeof captured.body.name === 'string' ? captured.body.name : 'Created URL document',
      ),
    );
  });

  return { handler, captured };
}

export function createKnowledgeBaseFileCapturingHandler() {
  const captured: {
    name?: string;
    parent_folder_id?: string;
    file_name?: string;
    file_text?: string;
  } = {};

  const handler = http.post(`${BASE_V1}/convai/knowledge-base/file`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    const formData = await request.formData();
    const file = formData.get('file');
    const name = formData.get('name');
    const parentFolderId = formData.get('parent_folder_id');

    if (file instanceof File) {
      captured.file_name = file.name;
      captured.file_text = await file.text();
    }
    if (typeof name === 'string') {
      captured.name = name;
    }
    if (typeof parentFolderId === 'string') {
      captured.parent_folder_id = parentFolderId;
    }

    return HttpResponse.json(
      createdKnowledgeBaseResponse(
        'doc_created_file_123',
        captured.name ?? 'Created file document',
      ),
    );
  });

  return { handler, captured };
}

export function createDeleteKnowledgeBaseCapturingHandler() {
  const captured: { force?: string | null } = {};

  const handler = http.delete(`${BASE_V1}/convai/knowledge-base/:documentationId`, ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.force = new URL(request.url).searchParams.get('force');
    return new HttpResponse(null, { status: 204 });
  });

  return { handler, captured };
}

export function createRagIndexCapturingHandler() {
  const captured: { body?: JsonBody } = {};

  const handler = http.post(`${BASE_V1}/convai/knowledge-base/:documentationId/rag-index`, async ({ request }) => {
    const authErr = requireAuth(request.headers.get('xi-api-key'));
    if (authErr) return authErr;
    captured.body = (await request.json()) as JsonBody;
    return HttpResponse.json(mockRagIndex);
  });

  return { handler, captured };
}
