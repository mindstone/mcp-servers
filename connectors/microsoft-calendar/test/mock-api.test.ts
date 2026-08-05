import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
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

  it('list_events includes per-attendee RSVP status (enveloped)', async () => {
    const result = await client.callTool('list_events', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      events: Array<{
        attendeeCount: number;
        attendees?: Array<{ email: string; name: string; type: string; status: string }>;
      }>;
    };
    const first = json.events[0];
    expect(first?.attendeeCount).toBe(2);
    expect(first?.attendees).toHaveLength(2);
    expect(first?.attendees?.[0]?.status).toBe('accepted');
    expect(first?.attendees?.[1]?.status).toBe('declined');
    expect(first?.attendees?.[0]?.email).toContain('<untrusted-content');
    expect(first?.attendees?.[0]?.email).toContain('bob@example.com');
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

  it('get_event with includeAttachments lists enveloped attachment metadata', async () => {
    const result = await client.callTool('get_event', { id: 'event-1', includeAttachments: true });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      attachments?: Array<{ id: string; name: string; contentType: string; size: number }>;
    };
    expect(json.attachments).toHaveLength(2);
    expect(json.attachments?.[0]?.id).toBe('att-1');
    expect(json.attachments?.[0]?.name).toContain('<untrusted-content');
    expect(json.attachments?.[0]?.name).toContain('Agenda.docx');
    expect(json.attachments?.[0]?.size).toBe(12345);
    const call = state.requests.find((r) => r.pathname.endsWith('/me/events/event-1/attachments'));
    expect(call).toBeDefined();
  });

  it('get_event without includeAttachments does not call the attachments endpoint', async () => {
    const result = await client.callTool('get_event', { id: 'event-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { attachments?: unknown };
    expect(json.attachments).toBeUndefined();
    const call = state.requests.find((r) => r.pathname.endsWith('/attachments'));
    expect(call).toBeUndefined();
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

  it('create_event passes a recurrence object through to the Graph body', async () => {
    const recurrence = {
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
      range: { type: 'endDate', startDate: '2026-05-20', endDate: '2026-08-20' },
    };
    const result = await client.callTool('create_event', {
      subject: 'Weekly Sync',
      start: '2026-05-20T09:00:00',
      end: '2026-05-20T09:30:00',
      recurrence,
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/events'),
    );
    expect(call?.body).toMatchObject({ recurrence });
  });

  it('create_event rejects a malformed recurrence object', async () => {
    const result = await client.callTool('create_event', {
      subject: 'Weekly Sync',
      start: '2026-05-20T09:00:00',
      end: '2026-05-20T09:30:00',
      recurrence: { pattern: { type: 'everyFullMoon' }, range: { type: 'noEnd', startDate: '2026-05-20' } },
    });
    expect(result.isError).toBe(true);
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

  it('update_event passes recurrence through to the PATCH body', async () => {
    const recurrence = {
      pattern: { type: 'daily', interval: 2 },
      range: { type: 'numbered', startDate: '2026-05-20', numberOfOccurrences: 10 },
    };
    const result = await client.callTool('update_event', { id: 'event-1', recurrence });
    expect(result.isError).not.toBe(true);
    const patch = state.requests.find(
      (r) => r.method === 'PATCH' && r.pathname.endsWith('/me/events/event-1'),
    );
    expect(patch?.body).toMatchObject({ recurrence });
  });

  it('update_event addAttendees merges against the current attendee list', async () => {
    const result = await client.callTool('update_event', {
      id: 'event-1',
      addAttendees: ['carol@example.com'],
    });
    expect(result.isError).not.toBe(true);
    const patch = state.requests.find(
      (r) => r.method === 'PATCH' && r.pathname.endsWith('/me/events/event-1'),
    );
    // Current list from the GET (bob) is preserved; carol is appended.
    expect(patch?.body).toMatchObject({
      attendees: [
        { emailAddress: { address: 'bob@example.com', name: 'Bob' }, type: 'required' },
        { emailAddress: { address: 'carol@example.com' }, type: 'required' },
      ],
    });
  });

  it('update_event removeAttendees drops the address from the merged list', async () => {
    const result = await client.callTool('update_event', {
      id: 'event-1',
      removeAttendees: ['BOB@example.com'],
    });
    expect(result.isError).not.toBe(true);
    const patch = state.requests.find(
      (r) => r.method === 'PATCH' && r.pathname.endsWith('/me/events/event-1'),
    );
    expect(patch?.body).toMatchObject({ attendees: [] });
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
  // cancel_event
  // -------------------------------------------------------------------------
  it('cancel_event POSTs to /me/events/{id}/cancel with the comment', async () => {
    const result = await client.callTool('cancel_event', {
      id: 'event-1',
      comment: 'Rescheduling to next week',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; success: boolean; message: string };
    expect(json.ok).toBeUndefined();
    expect(json.success).toBe(true);
    expect(json.message).toContain('cancelled');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/events/event-1/cancel'),
    );
    expect(call?.body).toMatchObject({ comment: 'Rescheduling to next week' });
  });

  it('cancel_event rejects missing id with WARNING guidance', async () => {
    const result = await client.callTool('cancel_event', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('WARNING');
    expect(json.next_step).toBe('list_events');
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
  // find_meeting_times
  // -------------------------------------------------------------------------
  it('find_meeting_times suggests free slots from the getSchedule availabilityView', async () => {
    // Mock returns availabilityView '000000' (6 x 30-min free buckets).
    const result = await client.callTool('find_meeting_times', {
      attendees: ['alice@example.com'],
      startDateTime: '2026-05-20T09:00:00',
      endDateTime: '2026-05-20T12:00:00',
      durationMinutes: 60,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      suggestionCount: number;
      timeZone: string;
      suggestions: Array<{ start: string; end: string }>;
    };
    expect(json.suggestionCount).toBe(5); // default maxSuggestions cap
    expect(json.timeZone).toBe('America/Los_Angeles');
    expect(json.suggestions[0]).toEqual({
      start: '2026-05-20T09:00:00',
      end: '2026-05-20T10:00:00',
    });
    expect(json.suggestions[1]?.start).toBe('2026-05-20T09:30:00');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/calendar/getSchedule'),
    );
    expect(call?.body).toMatchObject({
      schedules: ['alice@example.com'],
      startTime: { dateTime: '2026-05-20T09:00:00', timeZone: 'America/Los_Angeles' },
      availabilityViewInterval: 30,
    });
  });

  it('find_meeting_times skips buckets where any attendee is busy', async () => {
    mswServer.use(
      http.post('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', () =>
        HttpResponse.json({
          value: [
            { scheduleId: 'alice@example.com', availabilityView: '2200' },
            { scheduleId: 'bob@example.com', availabilityView: '0200' },
          ],
        }),
      ),
    );
    const result = await client.callTool('find_meeting_times', {
      attendees: ['alice@example.com', 'bob@example.com'],
      startDateTime: '2026-05-20T09:00:00',
      endDateTime: '2026-05-20T11:00:00',
      durationMinutes: 30,
      intervalMinutes: 30,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { suggestions: Array<{ start: string; end: string }> };
    // Only buckets 2 and 3 (10:00-11:00) are free for both attendees.
    expect(json.suggestions).toEqual([
      { start: '2026-05-20T10:00:00', end: '2026-05-20T10:30:00' },
      { start: '2026-05-20T10:30:00', end: '2026-05-20T11:00:00' },
    ]);
  });

  it('find_meeting_times converts offset-bearing window times to the resolved zone', async () => {
    // 16:00Z = 09:00 in America/Los_Angeles (May, PDT).
    const result = await client.callTool('find_meeting_times', {
      attendees: ['alice@example.com'],
      startDateTime: '2026-05-20T16:00:00Z',
      endDateTime: '2026-05-20T19:00:00Z',
      durationMinutes: 60,
      maxSuggestions: 1,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { suggestions: Array<{ start: string }> };
    expect(json.suggestions[0]?.start).toBe('2026-05-20T09:00:00');
  });

  it('find_meeting_times rejects missing parameters', async () => {
    const result = await client.callTool('find_meeting_times', {
      attendees: ['alice@example.com'],
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameters');
    expect(json.next_step).toBe('find_meeting_times');
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
