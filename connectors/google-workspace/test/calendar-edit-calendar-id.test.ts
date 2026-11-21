import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';

const EMAIL = 'user@example.com';
const CALENDARS_ROOT = 'https://www.googleapis.com/calendar/v3/calendars';
const SHARED_CALENDAR = 'team@group.calendar.google.com';

type ToolResponse = {
  isError?: boolean;
  content: Array<{ text: string }>;
};

type RecordedRequest = { method: string; calendarId: string; eventId: string; sendUpdates?: string | null; body?: Record<string, unknown> };

let directory: string | undefined;

async function loadServer() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-edit-calendar-id-'));
  const credentials = path.join(directory, 'credentials');
  fs.mkdirSync(credentials);
  fs.writeFileSync(path.join(directory, 'accounts.json'), JSON.stringify({
    accounts: [{ email: EMAIL, category: 'work' }],
  }));
  fs.writeFileSync(path.join(credentials, 'user-example-com.token.json'), JSON.stringify({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expiry_date: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/calendar',
  }));

  vi.stubEnv('ACCOUNTS_PATH', path.join(directory, 'accounts.json'));
  vi.stubEnv('CREDENTIALS_PATH', credentials);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
  vi.stubEnv('MCP_WORKSPACE_PATH', directory);
  vi.resetModules();

  const { initializeAllServices } = await import('../src/utils/service-initializer.js');
  await initializeAllServices();
  const { GSuiteServer } = await import('../src/tools/server.js');
  const server = new GSuiteServer() as unknown as {
    server: {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<ToolResponse>>;
    };
  };
  const handler = server.server._requestHandlers.get('tools/call');
  if (!handler) throw new Error('Tool call handler is not registered');

  return async (name: string, args: Record<string, unknown>): Promise<ToolResponse> => handler({
    method: 'tools/call',
    params: { name, arguments: { email: EMAIL, ...args } },
  }, {});
}

const RECURRING_EVENTS: Record<string, Record<string, unknown>> = {
  'instance-event': { id: 'instance-event', recurringEventId: 'master-event', start: { dateTime: '2026-01-05T10:00:00Z' }, originalStartTime: { dateTime: '2026-01-05T10:00:00Z' } },
  'master-event': { id: 'master-event', recurrence: ['RRULE:FREQ=DAILY'], start: { dateTime: '2026-01-01T10:00:00Z' } },
  // All-day daily series; its 21 Nov occurrence was moved to 10 Nov.
  'moved-instance': { id: 'moved-instance', recurringEventId: 'allday-master', start: { date: '2026-11-10' }, originalStartTime: { date: '2026-11-21' } },
  'allday-instance': { id: 'allday-instance', recurringEventId: 'allday-master', start: { date: '2026-11-02' }, originalStartTime: { date: '2026-11-02' } },
  'allday-master': { id: 'allday-master', recurrence: ['RRULE:FREQ=DAILY'], start: { date: '2026-11-01' } },
  // Timed series with a COUNT; its 21 Nov 15:00 UTC occurrence, written with a different offset.
  'timed-instance': { id: 'timed-instance', recurringEventId: 'timed-master', start: { dateTime: '2026-11-21T15:00:00Z' }, originalStartTime: { dateTime: '2026-11-21T16:00:00+01:00' } },
  // Round-3 probe: a series start without an offset (Google allows it with timeZone), and its second occurrence.
  'offsetless-instance': { id: 'offsetless-instance', recurringEventId: 'offsetless-master', start: { dateTime: '2026-01-02T09:00:00+14:00', timeZone: 'Pacific/Kiritimati' }, originalStartTime: { dateTime: '2026-01-02T09:00:00+14:00', timeZone: 'Pacific/Kiritimati' } },
  // Round-4 probe: a folded rule line hides COUNT from a plain split.
  'folded-instance': { id: 'folded-instance', recurringEventId: 'folded-master', start: { date: '2026-11-21' }, originalStartTime: { date: '2026-11-21' } },
  'folded-master': { id: 'folded-master', recurrence: ['RRULE:FREQ=DAILY;\r\n COUNT=30'], start: { date: '2026-11-01' } },
  'offsetless-master': { id: 'offsetless-master', recurrence: ['RRULE:FREQ=DAILY'], start: { dateTime: '2026-01-01T09:00:00', timeZone: 'Pacific/Kiritimati' } },
  'timed-master': { id: 'timed-master', recurrence: ['RRULE:FREQ=DAILY;COUNT=30', 'EXDATE:20261105T150000Z'], start: { dateTime: '2026-11-01T15:00:00Z' } },
  // The first occurrence of the all-day series, given by its occurrence id.
  'first-instance': { id: 'first-instance', recurringEventId: 'allday-master', start: { date: '2026-11-01' }, originalStartTime: { date: '2026-11-01' } },
  // A series that ended on 3 Nov, plus extra dates (RDATE) on 21 and 25 Nov.
  'rdate-instance': { id: 'rdate-instance', recurringEventId: 'rdate-master', start: { date: '2026-11-21' }, originalStartTime: { date: '2026-11-21' } },
  'rdate-master': { id: 'rdate-master', recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261103', 'RDATE;VALUE=DATE:20261121,20261125'], start: { date: '2026-11-01' } },
  'count-rdate-instance': { id: 'count-rdate-instance', recurringEventId: 'count-rdate-master', start: { date: '2026-11-21' }, originalStartTime: { date: '2026-11-21' } },
  'count-rdate-master': { id: 'count-rdate-master', recurrence: ['RRULE:FREQ=DAILY;COUNT=3', 'RDATE;VALUE=DATE:20261121'], start: { date: '2026-11-01' } },
};

function recordCalendarRequests(): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  const route = `${CALENDARS_ROOT}/:calendarId/events/:eventId`;
  mswServer.use(
    http.get(route, ({ params }) => {
      requests.push({ method: 'GET', calendarId: String(params.calendarId), eventId: String(params.eventId) });
      return HttpResponse.json(RECURRING_EVENTS[String(params.eventId)] ?? { id: String(params.eventId), summary: 'Old title' });
    }),
    http.patch(route, async ({ params, request }) => {
      const body = await request.json() as Record<string, unknown>;
      const sendUpdates = new URL(request.url).searchParams.get('sendUpdates');
      requests.push({ method: 'PATCH', calendarId: String(params.calendarId), eventId: String(params.eventId), sendUpdates, body });
      return HttpResponse.json({ id: String(params.eventId), htmlLink: 'https://calendar.google.com/event?eid=x' });
    }),
    http.delete(route, ({ params }) => {
      requests.push({ method: 'DELETE', calendarId: String(params.calendarId), eventId: String(params.eventId) });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return requests;
}

const NEW_TIMES = [{
  start: { dateTime: '2026-11-24T10:00:00Z' },
  end: { dateTime: '2026-11-24T11:00:00Z' },
}];

afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('manage_workspace_calendar_event update_time', () => {
  it('keeps the primary calendar and time-only patch when the new fields are omitted', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: 'evt-1', action: 'update_time', new_times: NEW_TIMES,
    });

    expect(response.isError).toBeFalsy();
    expect(requests.map(r => [r.method, r.calendarId])).toEqual([['GET', 'primary'], ['PATCH', 'primary']]);
    expect(requests[1].sendUpdates).toBe('all');
    expect(requests[1].body).toEqual({ start: NEW_TIMES[0].start, end: NEW_TIMES[0].end });
  });

  it('renames and moves an event on the given calendar', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: 'evt-2', action: 'update_time', new_times: NEW_TIMES, summary: 'New title', calendar_id: SHARED_CALENDAR,
    });

    expect(response.isError).toBeFalsy();
    expect(requests.map(r => [r.method, r.calendarId])).toEqual([['GET', SHARED_CALENDAR], ['PATCH', SHARED_CALENDAR]]);
    expect(requests[1].body).toMatchObject({ summary: 'New title', start: NEW_TIMES[0].start, end: NEW_TIMES[0].end });
  });

  it('renames without changing the time, and accepts the calendarId spelling', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: 'evt-3', action: 'update_time', summary: 'Renamed only', calendarId: SHARED_CALENDAR,
    });

    expect(response.isError).toBeFalsy();
    expect(requests[1]).toMatchObject({ method: 'PATCH', calendarId: SHARED_CALENDAR });
    expect(requests[1].body).toEqual({ summary: 'Renamed only' });
  });

  it('still refuses update_time with neither a new time nor a title', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', { event_id: 'evt-4', action: 'update_time' });

    expect(response.isError).toBe(true);
    expect(requests.some(r => r.method === 'PATCH')).toBe(false);
  });

  it('refuses an empty title', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: 'evt-5', action: 'update_time', summary: '   ',
    });

    expect(response.isError).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe('delete_workspace_calendar_event calendar_id', () => {
  it('deletes from the primary calendar when calendar_id is omitted', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('delete_workspace_calendar_event', { event_id: 'evt-6' });

    expect(response.isError).toBeFalsy();
    expect(requests).toEqual([{ method: 'DELETE', calendarId: 'primary', eventId: 'evt-6' }]);
  });

  it('deletes from the given calendar', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('delete_workspace_calendar_event', { event_id: 'evt-7', calendar_id: SHARED_CALENDAR });

    expect(response.isError).toBeFalsy();
    expect(requests).toEqual([{ method: 'DELETE', calendarId: SHARED_CALENDAR, eventId: 'evt-7' }]);
  });

  it('ends a recurring series from an instance on the given calendar', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('delete_workspace_calendar_event', {
      event_id: 'instance-event', calendar_id: SHARED_CALENDAR, deletion_scope: 'this_and_following',
    });

    expect(response.isError).toBeFalsy();
    expect(requests.map(r => [r.method, r.calendarId, r.eventId])).toEqual([
      ['GET', SHARED_CALENDAR, 'instance-event'],
      ['GET', SHARED_CALENDAR, 'master-event'],
      ['PATCH', SHARED_CALENDAR, 'master-event'],
      ['DELETE', SHARED_CALENDAR, 'instance-event'],
    ]);
  });

  it('deletes the whole series for this_and_following from its first occurrence (the master)', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('delete_workspace_calendar_event', {
      event_id: 'master-event', calendar_id: SHARED_CALENDAR, deletion_scope: 'this_and_following',
    });

    expect(response.isError).toBeFalsy();
    expect(requests.map(r => [r.method, r.calendarId, r.eventId])).toEqual([
      ['GET', SHARED_CALENDAR, 'master-event'],
      ['DELETE', SHARED_CALENDAR, 'master-event'],
    ]);
  });

  it('deletes the series, not only the occurrence, for entire_series given an occurrence id', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('delete_workspace_calendar_event', {
      event_id: 'instance-event', calendar_id: SHARED_CALENDAR, deletion_scope: 'entire_series',
    });

    expect(response.isError).toBeFalsy();
    expect(requests.map(r => [r.method, r.calendarId, r.eventId])).toEqual([
      ['GET', SHARED_CALENDAR, 'instance-event'],
      ['DELETE', SHARED_CALENDAR, 'master-event'],
    ]);
  });
});

describe('delete_workspace_calendar_event this_and_following cut-off', () => {
  const patchedRecurrence = (requests: RecordedRequest[]) => requests.find(r => r.method === 'PATCH')?.body?.recurrence;
  const changes = (requests: RecordedRequest[]) => requests.filter(r => r.method !== 'GET');

  it('keeps the day before an all-day occurrence whatever the machine timezone', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('delete_workspace_calendar_event', { event_id: 'allday-instance', deletion_scope: 'this_and_following' });

    expect(response.isError).toBeFalsy();
    expect(patchedRecurrence(requests)).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261101']);
    expect(requests.filter(r => r.method === 'DELETE').map(r => r.eventId)).toEqual(['allday-instance']);
  });

  it('ends a timed series one second before the occurrence, in UTC, replacing COUNT', async () => {
    vi.stubEnv('TZ', 'Pacific/Auckland');
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('delete_workspace_calendar_event', { event_id: 'timed-instance', deletion_scope: 'this_and_following' });

    expect(response.isError).toBeFalsy();
    expect(patchedRecurrence(requests)).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261121T145959Z', 'EXDATE:20261105T150000Z']);
  });

  it('deletes the whole series when its first occurrence is given by occurrence id', async () => {
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('delete_workspace_calendar_event', { event_id: 'first-instance', deletion_scope: 'this_and_following' });

    expect(response.isError).toBeFalsy();
    expect(requests.map(r => `${r.method} ${r.eventId}`)).toEqual(['GET first-instance', 'GET allday-master', 'DELETE allday-master']);
  });

  // Everything outside the plain case is refused before any change, with what to do instead.
  it.each([
    ['a moved occurrence', 'moved-instance'],
    ['a series with extra one-off dates', 'rdate-instance'],
    ['a counted series with extra one-off dates', 'count-rdate-instance'],
    ['a series start without an exact offset (round-3 probe, machine in Honolulu)', 'offsetless-instance'],
    ['a folded repeat rule (round-4 probe)', 'folded-instance'],
  ])('refuses %s, changing nothing', async (_label, eventId) => {
    vi.stubEnv('TZ', 'Pacific/Honolulu');
    const requests = recordCalendarRequests();
    const call = await loadServer();

    const response = await call('delete_workspace_calendar_event', { event_id: eventId, deletion_scope: 'this_and_following' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('one by one');
    expect(changes(requests)).toEqual([]);
  });
});

describe('dot-only ids', () => {
  it.each([
    ['delete_workspace_calendar_event', { event_id: '..', calendar_id: SHARED_CALENDAR }],
    ['delete_workspace_calendar_event', { event_id: 'evt-8', calendar_id: '..' }],
    ['manage_workspace_calendar_event', { event_id: '.', action: 'update_time', summary: 'x' }],
    ['get_workspace_calendar_event', { event_id: '..' }],
  ])('%s refuses %j before any request', async (tool, args) => {
    const requests = recordCalendarRequests();
    // A dot segment collapses the URL (".../events/.." becomes ".../calendars/x/"), so the
    // event route above never sees it: record every Calendar request, whatever its path.
    const anyCalendarRequest: string[] = [];
    mswServer.use(http.all('https://www.googleapis.com/calendar/*', ({ request }) => {
      anyCalendarRequest.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({}, { status: 200 });
    }));
    const call = await loadServer();

    const response = await call(tool, args);

    expect(response.isError).toBe(true);
    expect(requests).toEqual([]);
    expect(anyCalendarRequest).toEqual([]);
  });
});
