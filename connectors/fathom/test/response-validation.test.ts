import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createFathomHandlers } from './helpers/fathom-mock-server.js';
import { createTestClient, type McpTestClient, type CallToolResult } from './helpers/mcp-test-client.js';
import { mockMeetings } from './fixtures/fathom-data.js';

const API_KEY = 'test-fathom-key';
const BASE = 'https://api.fathom.ai/external/v1';
// Vendor text planted in every bad reply; it must never reach tool output.
const MARKER = 'VENDOR-MARKER-7f3a';

type Method = 'get' | 'post';

interface Endpoint {
  family: string;
  method: Method;
  path: string;
  tool: string;
  args: Record<string, unknown>;
  // A reply that is valid JSON but the wrong shape for this endpoint.
  wrongShape: JsonBodyType;
}

const ENDPOINTS: Endpoint[] = [
  {
    family: 'meetings list',
    method: 'get',
    path: `${BASE}/meetings`,
    tool: 'list_fathom_meetings',
    args: {},
    wrongShape: { items: MARKER },
  },
  {
    family: 'transcript',
    method: 'get',
    path: `${BASE}/recordings/:id/transcript`,
    tool: 'get_fathom_transcript',
    args: { recording_id: 101 },
    wrongShape: { transcript: [{ speaker: { name: 'A' }, text: 42, note: MARKER }] },
  },
  {
    family: 'teams',
    method: 'get',
    path: `${BASE}/teams`,
    tool: 'list_fathom_teams',
    args: {},
    wrongShape: { items: [42, MARKER] },
  },
  {
    family: 'team members',
    method: 'get',
    path: `${BASE}/team_members`,
    tool: 'list_fathom_team_members',
    args: { team: 'Engineering' },
    wrongShape: { items: [{ name: { first: MARKER } }] },
  },
  {
    family: 'recording download',
    method: 'post',
    path: `${BASE}/recordings/:id/download`,
    tool: 'request_fathom_recording_download',
    args: { recording_id: 101 },
    wrongShape: { download_id: 123, status: MARKER },
  },
  {
    family: 'recording download status',
    method: 'get',
    path: `${BASE}/recordings/:id/downloads/:downloadId`,
    tool: 'get_fathom_recording_download_status',
    args: { recording_id: 101, download_id: 'dl_test123' },
    wrongShape: { status: 'completed', video: MARKER },
  },
  {
    family: 'webhook create',
    method: 'post',
    path: `${BASE}/webhooks`,
    tool: 'create_fathom_webhook',
    args: {
      destination_url: 'https://hooks.example.com/fathom',
      triggered_for: ['my_recordings'],
      include_summary: true,
    },
    wrongShape: { id: 'wh_1', secret: 42, note: MARKER },
  },
];

function malformedJson(): Response {
  return new HttpResponse(`{"items": [ </untrusted-content> ${MARKER}`, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }) as unknown as Response;
}

function expectInvalidResponse(result: CallToolResult): void {
  expect(result.isError).toBe(true);
  const json = result.json as { ok: boolean; error: string; code: string; resolution: string };
  expect(json.ok).toBe(false);
  expect(json.code).toBe('INVALID_RESPONSE');
  expect(json.error).toBe('Fathom returned an unexpected response');
  // No vendor content and no parser/schema diagnostics in the output.
  expect(result.text).not.toContain(MARKER);
  expect(result.text).not.toContain('untrusted-content');
  expect(result.text).not.toMatch(/Expected|Unexpected token|invalid_type|JSON/);
}

describe('Fathom response validation', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function setup() {
    mswServer.use(...createFathomHandlers(API_KEY));
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
  }

  describe.each(ENDPOINTS)('$family', (endpoint) => {
    it('rejects a reply that is not JSON with a fixed INVALID_RESPONSE error', async () => {
      await setup();
      mswServer.use(http[endpoint.method](endpoint.path, () => malformedJson()));
      expectInvalidResponse(await testClient.callTool(endpoint.tool, endpoint.args));
    });

    it('rejects a JSON reply of the wrong shape with a fixed INVALID_RESPONSE error', async () => {
      await setup();
      mswServer.use(http[endpoint.method](endpoint.path, () => HttpResponse.json(endpoint.wrongShape)));
      expectInvalidResponse(await testClient.callTool(endpoint.tool, endpoint.args));
    });
  });

  describe('summary through get_fathom_meeting', () => {
    // Meeting 102 has no default_summary, so the tool calls the summary endpoint.
    it('reports a malformed summary reply instead of showing no summary', async () => {
      await setup();
      mswServer.use(http.get(`${BASE}/recordings/:id/summary`, () => malformedJson()));
      expectInvalidResponse(await testClient.callTool('get_fathom_meeting', { recording_id: 102 }));
    });

    it('reports a wrong-shape summary reply instead of showing no summary', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/recordings/:id/summary`, () =>
          HttpResponse.json({ summary: { markdown_formatted: { text: MARKER } } }),
        ),
      );
      expectInvalidResponse(await testClient.callTool('get_fathom_meeting', { recording_id: 102 }));
    });

    it.each([
      { status: 401, code: 'AUTH_FAILED' },
      { status: 500, code: 'API_ERROR' },
    ])('reports a summary fetch $status as $code instead of showing no summary', async ({ status, code }) => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/recordings/:id/summary`, () => HttpResponse.json({ error: MARKER }, { status })),
      );
      const result = await testClient.callTool('get_fathom_meeting', { recording_id: 102 });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; code: string };
      expect(json.ok).toBe(false);
      expect(json.code).toBe(code);
    });

    it('reports a summary fetch timeout as TIMEOUT instead of showing no summary', async () => {
      await setup();
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/summary')) {
          return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
        }
        return realFetch(input, init);
      });
      const result = await testClient.callTool('get_fathom_meeting', { recording_id: 102 });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; code: string };
      expect(json.ok).toBe(false);
      expect(json.code).toBe('TIMEOUT');
    });

    it('still shows summary: null when the meeting has no summary (404)', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/recordings/:id/summary`, () => HttpResponse.json({ error: 'Not found' }, { status: 404 })),
      );
      const result = await testClient.callTool('get_fathom_meeting', { recording_id: 102 });
      expect(result.isError).toBeFalsy();
      const json = result.json as { ok: boolean; meeting: { summary: unknown } };
      expect(json.ok).toBe(true);
      expect(json.meeting.summary).toBeNull();
    });

    it('shows summary: null for an async-callback reply that carries no summary', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/recordings/:id/summary`, () =>
          HttpResponse.json({ destination_url: 'https://hooks.example.com/summary' }),
        ),
      );
      const result = await testClient.callTool('get_fathom_meeting', { recording_id: 102 });
      const json = result.json as { ok: boolean; meeting: { summary: unknown } };
      expect(json.ok).toBe(true);
      expect(json.meeting.summary).toBeNull();
    });
  });

  describe('nullable and omitted fields', () => {
    it('accepts a meeting with vendor-documented nulls and omitted optional fields', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/meetings`, () =>
          HttpResponse.json({
            limit: null,
            next_cursor: null,
            items: [
              {
                title: 'Sparse meeting',
                meeting_title: null,
                meeting_type: null,
                recording_id: 555,
                calendar_invitees: [
                  { name: null, email: null, email_domain: null, is_external: true },
                  { email: 'guest@example.com' },
                ],
                recorded_by: { name: 'Rae', email: 'rae@example.com', team: null },
                default_summary: { template_name: null, markdown_formatted: null },
                action_items: [
                  { description: 'Follow up', assignee: { name: null, email: null, team: null } },
                  { description: 'No assignee' },
                ],
              },
            ],
          }),
        ),
      );

      const list = await testClient.callTool('list_fathom_meetings', { include_action_items: true });
      expect(list.isError).toBeFalsy();
      const listJson = list.json as { ok: boolean; meetings: Array<{ recording_id: number }> };
      expect(listJson.ok).toBe(true);
      expect(listJson.meetings[0].recording_id).toBe(555);

      const participants = await testClient.callTool('get_fathom_meeting_participants', { recording_id: 555 });
      const pJson = participants.json as {
        ok: boolean;
        participants: Array<{ name: string | null; email: string | null; is_external: boolean }>;
      };
      expect(pJson.ok).toBe(true);
      expect(pJson.participants).toHaveLength(2);
      expect(pJson.participants[0].name).toBeNull();
      expect(pJson.participants[1].is_external).toBe(false);

      const actions = await testClient.callTool('get_fathom_action_items', {});
      const aJson = actions.json as { ok: boolean; action_items: Array<{ assignee: unknown; completed: boolean }> };
      expect(aJson.ok).toBe(true);
      expect(aJson.action_items).toHaveLength(2);
      expect(aJson.action_items[1].assignee).toBeNull();
      expect(aJson.action_items[1].completed).toBe(false);
    });

    it('accepts a meeting with no invitees, recorder or summary fields at all', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/meetings`, () =>
          HttpResponse.json({ items: [{ title: 'Bare', recording_id: 556 }] }),
        ),
        http.get(`${BASE}/recordings/:id/summary`, () => HttpResponse.json({ error: 'Not found' }, { status: 404 })),
      );
      const result = await testClient.callTool('get_fathom_meeting', { recording_id: 556 });
      const json = result.json as { ok: boolean; meeting: { calendar_invitees: unknown[]; summary: unknown } };
      expect(json.ok).toBe(true);
      expect(json.meeting.calendar_invitees).toEqual([]);
      expect(json.meeting.summary).toBeNull();
    });

    it('accepts transcript entries using the vendor shape (timestamp, display_name) and missing speakers', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/recordings/:id/transcript`, () =>
          HttpResponse.json({
            transcript: [
              { speaker: { display_name: 'Dee', matched_calendar_invitee_email: null }, timestamp: '00:01:02', text: 'Hi.' },
              { speaker: null, start_time: null, text: 'Who said this?' },
              { text: 'No speaker key at all.' },
            ],
          }),
        ),
      );
      const result = await testClient.callTool('get_fathom_transcript', { recording_id: 101 });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('[00:01:02] Dee: Hi.');
      expect(result.text).toContain('[00:00:00] Unknown: Who said this?');
      expect(result.text).toContain('[00:00:00] Unknown: No speaker key at all.');
    });

    it('treats an async-callback transcript reply as an empty transcript', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/recordings/:id/transcript`, () =>
          HttpResponse.json({ destination_url: 'https://hooks.example.com/transcript' }),
        ),
      );
      const result = await testClient.callTool('get_fathom_transcript', { recording_id: 101 });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Transcript (0 of 0 entries)');
    });

    it('accepts team items as plain strings and members with null fields', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/teams`, () =>
          HttpResponse.json({ limit: 25, next_cursor: null, items: ['Ops', { name: 'Legal', created_at: null }] }),
        ),
        http.get(`${BASE}/team_members`, () =>
          HttpResponse.json({ limit: 25, next_cursor: null, items: [{ name: null, email: 'x@example.com' }] }),
        ),
      );
      const teams = await testClient.callTool('list_fathom_teams', {});
      const tJson = teams.json as { ok: boolean; teams: Array<{ name: string }> };
      expect(tJson.ok).toBe(true);
      expect(tJson.teams).toHaveLength(2);
      expect(tJson.teams[0].name).toContain('Ops');

      const members = await testClient.callTool('list_fathom_team_members', { team: 'Ops' });
      const mJson = members.json as { ok: boolean; teamMembers: Array<{ email: string }> };
      expect(mJson.ok).toBe(true);
      expect(mJson.teamMembers[0].email).toBe('x@example.com');
    });

    it('accepts a processing download with no file and an unrecognised status', async () => {
      await setup();
      mswServer.use(
        http.post(`${BASE}/recordings/:id/download`, () =>
          HttpResponse.json({ download_id: 'dl_new', recording_id: 101, status: 'queued' }),
        ),
      );
      const result = await testClient.callTool('request_fathom_recording_download', { recording_id: 101 });
      const json = result.json as { ok: boolean; download_id: string; status: string; url?: string };
      expect(json.ok).toBe(true);
      expect(json.download_id).toBe('dl_new');
      expect(json.status).toBe('queued');
      expect(json.url).toBeUndefined();
    });

    it('accepts a webhook reply without the optional flags or triggered_for', async () => {
      await setup();
      mswServer.use(
        http.post(`${BASE}/webhooks`, () =>
          HttpResponse.json({ id: 'wh_min', url: 'https://hooks.example.com/fathom', secret: 'whsec_min' }),
        ),
      );
      const result = await testClient.callTool('create_fathom_webhook', {
        destination_url: 'https://hooks.example.com/fathom',
        triggered_for: ['my_recordings'],
        include_summary: true,
      });
      const json = result.json as { ok: boolean; webhook: { id: string; triggered_for: string[] }; secret: string };
      expect(json.ok).toBe(true);
      expect(json.webhook.id).toBe('wh_min');
      expect(json.webhook.triggered_for).toEqual(['my_recordings']);
      expect(json.secret).toBe('whsec_min');
    });
  });

  describe('rate-limit retry still validates the final reply', () => {
    it('gives INVALID_RESPONSE for a schema-invalid 200 after a 429', async () => {
      await setup();
      let requestCount = 0;
      mswServer.use(
        http.get(`${BASE}/meetings`, () => {
          requestCount++;
          if (requestCount === 1) {
            return HttpResponse.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': '0' } });
          }
          return HttpResponse.json({ items: MARKER });
        }),
      );
      expectInvalidResponse(await testClient.callTool('list_fathom_meetings', {}));
      expect(requestCount).toBe(2);
    });
  });

  describe('identifiers a result is useless without', () => {
    const webhookArgs = {
      destination_url: 'https://hooks.example.com/fathom',
      triggered_for: ['my_recordings'],
      include_summary: true,
    };

    it.each([
      { case: 'no id or secret', body: { url: 'https://hooks.example.com/fathom', note: MARKER } },
      { case: 'no id', body: { secret: 'whsec_x', note: MARKER } },
      { case: 'no secret', body: { id: 'wh_x', note: MARKER } },
    ])('rejects a created webhook with $case', async ({ body }) => {
      await setup();
      mswServer.use(http.post(`${BASE}/webhooks`, () => HttpResponse.json(body)));
      expectInvalidResponse(await testClient.callTool('create_fathom_webhook', webhookArgs));
    });

    it('rejects a download request reply with no download_id', async () => {
      await setup();
      mswServer.use(
        http.post(`${BASE}/recordings/:id/download`, () =>
          HttpResponse.json({ recording_id: 101, status: 'processing', note: MARKER }),
        ),
      );
      expectInvalidResponse(await testClient.callTool('request_fathom_recording_download', { recording_id: 101 }));
    });

    it('still accepts a meeting list item without a recording_id', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/meetings`, () =>
          HttpResponse.json({ items: [{ title: 'No id' }, { title: 'Has id', recording_id: 7 }] }),
        ),
      );
      const result = await testClient.callTool('list_fathom_meetings', {});
      const json = result.json as { ok: boolean; meetings: Array<{ recording_id?: number }> };
      expect(json.ok).toBe(true);
      expect(json.meetings).toHaveLength(2);
    });
  });

  describe('pass-through fields of an unexpected type are kept as sent', () => {
    it('keeps a numeric meeting created_at', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/meetings`, () =>
          HttpResponse.json({ items: [{ title: 'Epoch', recording_id: 777, created_at: 1735689600 }] }),
        ),
        http.get(`${BASE}/recordings/:id/summary`, () => HttpResponse.json({ error: 'Not found' }, { status: 404 })),
      );
      const list = await testClient.callTool('list_fathom_meetings', {});
      const listJson = list.json as { ok: boolean; meetings: Array<{ created_at: unknown }> };
      expect(listJson.ok).toBe(true);
      expect(listJson.meetings[0].created_at).toBe(1735689600);

      const one = await testClient.callTool('get_fathom_meeting', { recording_id: 777 });
      const oneJson = one.json as { ok: boolean; meeting: { created_at: unknown } };
      expect(oneJson.ok).toBe(true);
      expect(oneJson.meeting.created_at).toBe(1735689600);
    });

    it('keeps a numeric team-member id', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/team_members`, () =>
          HttpResponse.json({ items: [{ name: 'Rae', email: 'rae@example.com', id: 42 }] }),
        ),
      );
      const result = await testClient.callTool('list_fathom_team_members', { team: 'Ops' });
      const json = result.json as { ok: boolean; teamMembers: Array<{ id: unknown }> };
      expect(json.ok).toBe(true);
      expect(json.teamMembers[0].id).toBe(42);
    });

    it('keeps a string transcript end_time', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/recordings/:id/transcript`, () =>
          HttpResponse.json({
            transcript: [{ speaker: { name: 'Dee' }, start_time: 1, end_time: '00:00:04', text: 'Hi.' }],
          }),
        ),
      );
      const result = await testClient.callTool('get_fathom_transcript', { recording_id: 101, format: 'json' });
      const json = result.json as { ok: boolean; transcript: Array<{ end_time: unknown }> };
      expect(json.ok).toBe(true);
      expect(json.transcript[0].end_time).toBe('00:00:04');
    });
  });

  describe('unknown fields are kept', () => {
    it('keeps unknown top-level and nested meeting fields in list output', async () => {
      await setup();
      const [base] = mockMeetings;
      mswServer.use(
        http.get(`${BASE}/meetings`, () =>
          HttpResponse.json({
            limit: 25,
            next_cursor: null,
            items: [
              {
                ...base,
                crm_matches: { companies: [{ name: 'Acme Corp' }] },
                calendar_invitees: [{ ...base.calendar_invitees[0], matched_speaker_display_name: 'Alice A.', seat: 4 }],
                recorded_by: { ...base.recorded_by, badge: 'gold' },
                action_items: [
                  { ...base.action_items![0], priority: 'high', assignee: { ...base.action_items![0].assignee, title: 'PM' } },
                ],
              },
            ],
          }),
        ),
      );

      const result = await testClient.callTool('list_fathom_meetings', { include_action_items: true });
      const json = result.json as {
        ok: boolean;
        meetings: Array<{
          crm_matches: unknown;
          calendar_invitees: Array<Record<string, unknown>>;
          recorded_by: Record<string, unknown>;
          action_items: Array<Record<string, unknown> & { assignee: Record<string, unknown> }>;
        }>;
      };
      expect(json.ok).toBe(true);
      const [meeting] = json.meetings;
      expect(meeting.crm_matches).toEqual({ companies: [{ name: 'Acme Corp' }] });
      expect(meeting.calendar_invitees[0].seat).toBe(4);
      expect(meeting.calendar_invitees[0].matched_speaker_display_name).toBe('Alice A.');
      expect(meeting.recorded_by.badge).toBe('gold');
      expect(meeting.action_items[0].priority).toBe('high');
      expect(meeting.action_items[0].assignee.title).toBe('PM');
    });

    it('keeps unknown transcript entry and speaker fields in json output', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/recordings/:id/transcript`, () =>
          HttpResponse.json({
            transcript: [
              { speaker: { display_name: 'Dee', voice_id: 'v-9' }, timestamp: '00:00:01', text: 'Hi.', confidence: 0.98 },
            ],
          }),
        ),
      );
      const result = await testClient.callTool('get_fathom_transcript', { recording_id: 101, format: 'json' });
      const json = result.json as {
        ok: boolean;
        transcript: Array<{ confidence: number; speaker: { voice_id: string } }>;
      };
      expect(json.ok).toBe(true);
      expect(json.transcript[0].confidence).toBe(0.98);
      expect(json.transcript[0].speaker.voice_id).toBe('v-9');
    });

    it('keeps unknown team and member fields in output', async () => {
      await setup();
      mswServer.use(
        http.get(`${BASE}/teams`, () =>
          HttpResponse.json({ limit: 25, next_cursor: null, items: [{ name: 'Ops', size: 12 }] }),
        ),
        http.get(`${BASE}/team_members`, () =>
          HttpResponse.json({
            limit: 25,
            next_cursor: null,
            items: [{ name: 'Rae', email: 'rae@example.com', created_at: '2025-03-01T00:00:00Z', timezone: 'UTC' }],
          }),
        ),
      );
      const teams = await testClient.callTool('list_fathom_teams', {});
      expect((teams.json as { teams: Array<{ size: number }> }).teams[0].size).toBe(12);

      const members = await testClient.callTool('list_fathom_team_members', { team: 'Ops' });
      const member = (members.json as { teamMembers: Array<Record<string, unknown>> }).teamMembers[0];
      expect(member.timezone).toBe('UTC');
      expect(member.created_at).toBe('2025-03-01T00:00:00Z');
    });
  });
});
