import { http, HttpResponse } from 'msw';

const OUTREACH_API_BASE = 'https://api.outreach.io/api/v2';
const OUTREACH_OAUTH_URL = 'https://api.outreach.io/oauth/token';

/** Valid mock access token for tests. */
export const MOCK_ACCESS_TOKEN = 'mock-outreach-access-token-0001';

const mockProspect = {
  id: '101',
  type: 'prospect',
  attributes: {
    firstName: 'Jane',
    lastName: 'Doe',
    emails: ['jane@acme.com'],
    title: 'VP Sales',
    company: 'Acme Corp',
    tags: ['lead'],
    createdAt: '2026-01-15T10:00:00Z',
  },
  relationships: {
    account: { data: { id: '201', type: 'account' } },
  },
};

const mockSequence = {
  id: '301',
  type: 'sequence',
  attributes: {
    name: 'Demo Follow-up',
    enabled: true,
    sequenceStepCount: 5,
  },
};

const mockAccount = {
  id: '201',
  type: 'account',
  attributes: {
    name: 'Acme Corp',
    domain: 'acme.com',
    industry: 'Technology',
  },
};

const mockTask = {
  id: '401',
  type: 'task',
  attributes: {
    state: 'incomplete',
    taskType: 'call',
    note: 'Follow up with Jane',
    dueAt: '2026-05-01T00:00:00Z',
  },
  relationships: {
    prospect: { data: { id: '101', type: 'prospect' } },
  },
};

const mockMailing = {
  id: '501',
  type: 'mailing',
  attributes: {
    subject: 'Follow-up email',
    state: 'delivered',
    deliveredAt: '2026-04-15T10:00:00Z',
  },
  relationships: {
    prospect: { data: { id: '101', type: 'prospect' } },
  },
};

const mockUser = {
  id: '601',
  type: 'user',
  attributes: {
    firstName: 'John',
    lastName: 'Smith',
    email: 'john@company.com',
    role: 'admin',
  },
};

const mockCall = {
  id: '1101',
  type: 'call',
  attributes: {
    state: 'completed',
    direction: 'outbound',
    outcome: 'completed',
    note: 'Discussed renewal timeline',
    answeredAt: '2026-04-20T14:00:15Z',
    completedAt: '2026-04-20T14:32:00Z',
  },
  relationships: {
    prospect: { data: { id: '101', type: 'prospect' } },
    user: { data: { id: '601', type: 'user' } },
    callDisposition: { data: { id: '1201', type: 'callDisposition' } },
  },
};

const mockSequenceState = {
  id: '701',
  type: 'sequenceState',
  attributes: {
    state: 'active',
  },
  relationships: {
    prospect: { data: { id: '101', type: 'prospect' } },
    sequence: { data: { id: '301', type: 'sequence' } },
  },
};

const mockSequenceStep = {
  id: '801',
  type: 'sequenceStep',
  attributes: {
    stepType: 'auto_email',
    interval: 120,
    order: 1,
  },
  relationships: {
    sequence: { data: { id: '301', type: 'sequence' } },
    sequenceTemplates: { data: [{ id: '901', type: 'sequenceTemplate' }] },
  },
};

const mockSequenceTemplate = {
  id: '901',
  type: 'sequenceTemplate',
  attributes: {
    enabled: true,
  },
  relationships: {
    sequenceStep: { data: { id: '801', type: 'sequenceStep' } },
    template: { data: { id: '1001', type: 'template' } },
  },
};

const mockTemplate = {
  id: '1001',
  type: 'template',
  attributes: {
    name: 'Intro email',
    subject: 'Hello from Acme',
    bodyHtml: '<p>Hi {{first_name}}, following up on our conversation.</p>',
  },
};

function requireAuth(authHeader: string | null): HttpResponse | null {
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== MOCK_ACCESS_TOKEN) {
    return HttpResponse.json(
      { errors: [{ title: 'Unauthorized', detail: 'Invalid or missing access token' }] },
      { status: 401 },
    );
  }
  return null;
}

function jsonApiList(data: Array<Record<string, unknown>>, count?: number) {
  return {
    data,
    meta: { count: count ?? data.length, page: { current: 1, total: 1 } },
    links: {},
  };
}

export function createOutreachHandlers() {
  return [
    // --- Prospects ---
    http.get(`${OUTREACH_API_BASE}/prospects`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json(jsonApiList([mockProspect]));
    }),

    http.get(`${OUTREACH_API_BASE}/prospects/:id`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      if (params.id === 'nonexistent') {
        return HttpResponse.json(
          { errors: [{ title: 'Not Found', detail: 'Prospect not found' }] },
          { status: 404 },
        );
      }
      if (params.id === 'trigger-500') {
        return HttpResponse.json(
          { errors: [{ title: 'Internal Server Error', detail: 'Something went wrong' }] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ data: { ...mockProspect, id: params.id } });
    }),

    http.post(`${OUTREACH_API_BASE}/prospects`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = (await request.json()) as Record<string, unknown>;
      const reqData = body.data as Record<string, unknown>;
      return HttpResponse.json({
        data: {
          ...mockProspect,
          id: '102',
          attributes: { ...mockProspect.attributes, ...(reqData?.attributes as Record<string, unknown> || {}) },
        },
      });
    }),

    http.patch(`${OUTREACH_API_BASE}/prospects/:id`, async ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = (await request.json()) as Record<string, unknown>;
      const reqData = body.data as Record<string, unknown>;
      return HttpResponse.json({
        data: {
          ...mockProspect,
          id: params.id as string,
          attributes: { ...mockProspect.attributes, ...(reqData?.attributes as Record<string, unknown> || {}) },
        },
      });
    }),

    // --- Sequences ---
    http.get(`${OUTREACH_API_BASE}/sequences`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json(jsonApiList([mockSequence]));
    }),

    http.get(`${OUTREACH_API_BASE}/sequences/:id`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json({ data: { ...mockSequence, id: params.id } });
    }),

    http.post(`${OUTREACH_API_BASE}/sequenceStates`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json({ data: mockSequenceState });
    }),

    http.get(`${OUTREACH_API_BASE}/sequenceStates`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const url = new URL(request.url);
      if (url.searchParams.get('filter[prospect][id]') === '999') {
        return HttpResponse.json(jsonApiList([], 0));
      }
      return HttpResponse.json(jsonApiList([mockSequenceState]));
    }),

    http.post(`${OUTREACH_API_BASE}/sequenceStates/:id/actions/:action`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const newState = params.action === 'finish' ? 'finished' : 'paused';
      return HttpResponse.json({
        data: {
          ...mockSequenceState,
          id: params.id,
          attributes: { ...mockSequenceState.attributes, state: newState },
        },
      });
    }),

    // --- Sequence content ---
    http.get(`${OUTREACH_API_BASE}/sequenceSteps`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json(jsonApiList([mockSequenceStep]));
    }),

    http.get(`${OUTREACH_API_BASE}/sequenceTemplates/:id`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      if (params.id === 'nonexistent') {
        return HttpResponse.json(
          { errors: [{ title: 'Not Found', detail: 'Sequence template not found' }] },
          { status: 404 },
        );
      }
      return HttpResponse.json({ data: { ...mockSequenceTemplate, id: params.id } });
    }),

    http.get(`${OUTREACH_API_BASE}/templates/:id`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json({ data: { ...mockTemplate, id: params.id } });
    }),

    // --- Accounts ---
    http.get(`${OUTREACH_API_BASE}/accounts`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json(jsonApiList([mockAccount]));
    }),

    http.get(`${OUTREACH_API_BASE}/accounts/:id`, ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json({ data: { ...mockAccount, id: params.id } });
    }),

    // --- Tasks ---
    http.get(`${OUTREACH_API_BASE}/tasks`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json(jsonApiList([mockTask]));
    }),

    http.post(`${OUTREACH_API_BASE}/tasks`, async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = (await request.json()) as Record<string, unknown>;
      const reqData = body.data as Record<string, unknown>;
      return HttpResponse.json({
        data: {
          ...mockTask,
          id: '402',
          attributes: { ...mockTask.attributes, ...(reqData?.attributes as Record<string, unknown> || {}) },
          relationships: { ...mockTask.relationships, ...(reqData?.relationships as Record<string, unknown> || {}) },
        },
      });
    }),

    http.patch(`${OUTREACH_API_BASE}/tasks/:id`, async ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = (await request.json()) as Record<string, unknown>;
      const reqData = body.data as Record<string, unknown>;
      return HttpResponse.json({
        data: {
          ...mockTask,
          id: params.id as string,
          attributes: { ...mockTask.attributes, ...(reqData?.attributes as Record<string, unknown> || {}) },
        },
      });
    }),

    // --- Mailings ---
    http.get(`${OUTREACH_API_BASE}/mailings`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json(jsonApiList([mockMailing]));
    }),

    // --- Calls ---
    http.get(`${OUTREACH_API_BASE}/calls`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json(jsonApiList([mockCall]));
    }),

    // --- Users ---
    http.get(`${OUTREACH_API_BASE}/users`, ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json(jsonApiList([mockUser]));
    }),

    // --- OAuth Token Refresh ---
    http.post(OUTREACH_OAUTH_URL, async ({ request }) => {
      const body = await request.text();
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') {
        if (params.get('refresh_token') === 'expired-refresh-token') {
          return HttpResponse.json({ error: 'invalid_grant' }, { status: 401 });
        }
        return HttpResponse.json({
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: 'new-refresh-token',
          expires_in: 7200,
          scope: 'prospects.all',
          created_at: Math.floor(Date.now() / 1000),
        });
      }
      return HttpResponse.json({
        access_token: MOCK_ACCESS_TOKEN,
        refresh_token: 'mock-refresh-token',
        expires_in: 7200,
        scope: 'prospects.all',
        created_at: Math.floor(Date.now() / 1000),
      });
    }),
  ];
}
