import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

describe('microsoft-calendar mock-API integration', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;
  let state: MockApiState;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  beforeEach(() => {
    const mock = createMockApi();
    state = mock.state;
    mswServer.use(...mock.handlers);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  // -------------------------------------------------------------------------
  // list_events
  // -------------------------------------------------------------------------
  it('list_events returns the formatted JSON list and hits /me/calendarView', async () => {
    const result = await client.callTool('list_events', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      events: unknown[];
      timezoneInfo: { source: string; resolved: string };
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(2);
    expect(json.timezoneInfo.source).toBe('calendar_settings');
    expect(json.timezoneInfo.resolved).toBe('America/Los_Angeles');
    const call = state.requests.find((r) => r.pathname.endsWith('/me/calendarView'));
    expect(call).toBeDefined();
    expect(call?.search).toMatch(/\$top=5/);
  });

  it('list_events returnText=true returns agenda-style text (no JSON wrapper)', async () => {
    const result = await client.callTool('list_events', { returnText: true });
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain('Team Standup');
    expect(result.text).toContain('Reference: Today is');
    expect(result.json).toBeNull();
  });

  it('list_events with calendarId hits /me/calendars/{id}/calendarView', async () => {
    await client.callTool('list_events', { calendarId: 'cal-2', top: 1 });
    const call = state.requests.find((r) =>
      r.pathname.includes('/me/calendars/cal-2/calendarView'),
    );
    expect(call).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // get_event
  // -------------------------------------------------------------------------
  it('get_event returns event body and onlineMeetingUrl', async () => {
    const result = await client.callTool('get_event', { id: 'AAMkAGI2' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; body: string; onlineMeetingUrl: string };
    expect(json.ok).toBeUndefined();
    expect(json.body).toContain('Daily sync');
    expect(new URL(json.onlineMeetingUrl).hostname).toBe(
      ['teams', 'microsoft', 'com'].join('.'),
    );
  });

  it('get_event returns an error envelope when id is missing', async () => {
    const result = await client.callTool('get_event', {});
    expect(result.isError).toBe(true);
    const json = result.json as {
      ok: boolean;
      error: string;
      action_required: string;
      next_step: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameter');
    expect(json.next_step).toBe('list_events');
  });

  // -------------------------------------------------------------------------
  // create_event
  // -------------------------------------------------------------------------
  it('create_event POSTs to /me/events with resolved timezone wrapper', async () => {
    const result = await client.callTool('create_event', {
      subject: 'New Meeting',
      start: '2026-05-20T09:00:00',
      end: '2026-05-20T10:00:00',
      location: 'Room A',
      attendees: ['alice@example.com'],
      isOnlineMeeting: true,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; eventId: string; onlineMeetingUrl: string };
    expect(json.ok).toBeUndefined();
    expect(json.eventId).toBe('new-event-1');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/events'),
    );
    expect(call?.body).toMatchObject({
      subject: 'New Meeting',
      start: { dateTime: '2026-05-20T09:00:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-05-20T10:00:00', timeZone: 'America/Los_Angeles' },
      location: { displayName: 'Room A' },
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    });
  });

  it('create_event rejects "title" alias with explicit guidance', async () => {
    const result = await client.callTool('create_event', {
      title: 'Meeting',
      start: '2026-05-20T09:00:00',
      end: '2026-05-20T10:00:00',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('"subject" instead of "title"/"name"/"summary"');
    expect(json.next_step).toBe('create_event');
  });

  it('create_event rejects "startDateTime"/"endDateTime" aliases with explicit guidance', async () => {
    const startResult = await client.callTool('create_event', {
      subject: 'Meeting',
      startDateTime: '2026-05-20T09:00:00',
      end: '2026-05-20T10:00:00',
    });
    expect(startResult.isError).toBe(true);
    expect((startResult.json as { error: string }).error).toContain('"start" instead of');

    const endResult = await client.callTool('create_event', {
      subject: 'Meeting',
      start: '2026-05-20T09:00:00',
      endTime: '2026-05-20T10:00:00',
    });
    expect(endResult.isError).toBe(true);
    expect((endResult.json as { error: string }).error).toContain('"end" instead of');
  });

  it('create_event rejects missing required fields', async () => {
    const result = await client.callTool('create_event', { subject: 'Meeting' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameters');
    expect(json.next_step).toBe('create_event');
  });

  // -------------------------------------------------------------------------
  // update_event
  // -------------------------------------------------------------------------
  it('update_event PATCHes /me/events/{id} with a partial body', async () => {
    const result = await client.callTool('update_event', {
      id: 'event-1',
      subject: 'Renamed',
      location: 'Room B',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'PATCH' && r.pathname.endsWith('/me/events/event-1'),
    );
    expect(call?.body).toMatchObject({
      subject: 'Renamed',
      location: { displayName: 'Room B' },
    });
  });

  it('update_event rejects calls with no fields to update', async () => {
    const result = await client.callTool('update_event', { id: 'event-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('At least one field to update');
    expect(json.next_step).toBe('update_event');
  });

  it('update_event rejects missing id', async () => {
    const result = await client.callTool('update_event', { subject: 'x' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.next_step).toBe('list_events');
  });

  // -------------------------------------------------------------------------
  // delete_event
  // -------------------------------------------------------------------------
  it('delete_event DELETEs /me/events/{id}', async () => {
    const result = await client.callTool('delete_event', { id: 'event-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; message: string };
    expect(json.ok).toBeUndefined();
    expect(json.message).toContain('deleted');
    const call = state.requests.find(
      (r) => r.method === 'DELETE' && r.pathname.endsWith('/me/events/event-1'),
    );
    expect(call).toBeDefined();
  });

  it('delete_event rejects missing id with WARNING guidance', async () => {
    const result = await client.callTool('delete_event', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('WARNING');
    expect(json.next_step).toBe('list_events');
  });

  // -------------------------------------------------------------------------
  // respond_to_event
  // -------------------------------------------------------------------------
  it('respond_to_event POSTs to /me/events/{id}/{response}', async () => {
    await client.callTool('respond_to_event', {
      id: 'event-1',
      response: 'accept',
      comment: 'See you there!',
    });
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/events/event-1/accept'),
    );
    expect(call?.body).toMatchObject({ sendResponse: true, comment: 'See you there!' });
  });

  it('respond_to_event rejects missing id or response', async () => {
    const result = await client.callTool('respond_to_event', { id: 'event-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameters');
  });

  // -------------------------------------------------------------------------
  // get_free_busy
  // -------------------------------------------------------------------------
  it('get_free_busy POSTs to /me/calendar/getSchedule', async () => {
    const result = await client.callTool('get_free_busy', {
      emails: ['alice@example.com'],
      startDateTime: '2026-05-20T08:00:00Z',
      endDateTime: '2026-05-20T18:00:00Z',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      schedules: Array<{ email: string; availability: string }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.schedules?.[0]?.email).toBe('alice@example.com');
    expect(json.schedules?.[0]?.availability).toBe('000000');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/calendar/getSchedule'),
    );
    expect(call?.body).toMatchObject({
      schedules: ['alice@example.com'],
      availabilityViewInterval: 30,
    });
  });

  it('get_free_busy rejects empty emails', async () => {
    const result = await client.callTool('get_free_busy', {
      emails: [],
      startDateTime: '2026-05-20T08:00:00Z',
      endDateTime: '2026-05-20T18:00:00Z',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameters');
  });

  // -------------------------------------------------------------------------
  // list_calendars
  // -------------------------------------------------------------------------
  it('list_calendars returns formatted calendars', async () => {
    const result = await client.callTool('list_calendars', {});
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      count: number;
      calendars: Array<{ id: string; isDefault: boolean }>;
    };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(2);
    expect(json.calendars[0]?.isDefault).toBe(true);
    const call = state.requests.find((r) => r.pathname.endsWith('/me/calendars'));
    expect(call).toBeDefined();
  });
});
