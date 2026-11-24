import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';

/**
 * Changing a repeating series' time must keep what the person did to single entries of it: one moved,
 * one deleted, one renamed. Google keys those single-entry changes to each entry's original start, so
 * a new series time leaves them behind and the series comes back as it was first written: a Tuesday
 * moved to 11:00 by hand goes back to the new series time, and one deleted by hand comes back. The fake
 * calendar below behaves that way; the tool has to put them back, and say
 * plainly which ones it could not keep.
 */

const EMAIL = 'user@example.com';
const CALENDARS_ROOT = 'https://www.googleapis.com/calendar/v3/calendars';
const MASTER = 'tue-series';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type ToolResponse = { isError?: boolean; content: Array<{ text: string }> };
type Slot = { dateTime: string; timeZone?: string };
type Attendee = { email: string; optional?: boolean; responseStatus?: string };
type Reminders = { useDefault?: boolean; overrides?: Array<{ method: string; minutes: number }> };
type Override = { status?: 'cancelled'; start?: Slot; end?: Slot; summary?: string; description?: string; location?: string; attendees?: Attendee[]; reminders?: Reminders };

/** Google's patch: a nested object is merged into what is there, and a key set to null is removed. */
function mergePatch(base: unknown, patch: unknown): unknown {
  const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!plain(patch) || !plain(base)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

let directory: string | undefined;

async function loadServer() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-series-time-'));
  const credentials = path.join(directory, 'credentials');
  fs.mkdirSync(credentials);
  fs.writeFileSync(path.join(directory, 'accounts.json'), JSON.stringify({ accounts: [{ email: EMAIL, category: 'work' }] }));
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
    server: { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<ToolResponse>> };
  };
  const handler = server.server._requestHandlers.get('tools/call');
  if (!handler) throw new Error('Tool call handler is not registered');
  return async (name: string, args: Record<string, unknown>): Promise<ToolResponse> => handler({
    method: 'tools/call',
    params: { name, arguments: { email: EMAIL, ...args } },
  }, {});
}

/** The moment a time stands for, as Google reads it: one written without an offset is in its own time zone. */
function instantOf(slot: Slot) {
  if (/(Z|[+-]\d\d:\d\d)$/.test(slot.dateTime)) return Date.parse(slot.dateTime);
  const asUtc = Date.parse(`${slot.dateTime}Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: slot.timeZone ?? 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(asUtc)).map(part => [part.type, part.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - (wall - asUtc);
}
const utc = (slot: Slot, timeZone: string): Slot => ({ dateTime: new Date(instantOf(slot)).toISOString().replace('.000', ''), timeZone: slot.timeZone ?? timeZone });

const compact = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * A weekly series on a fake Google Calendar, by default in UTC (London in winter). Single-entry changes are
 * keyed by the entry's original start, as Google keys them: when the series' own start moves, they no
 * longer match any entry and are lost. Times come back in UTC, as Google's do for a calendar set to UTC
 * whatever the series' own zone. A note cleared on one entry is left out, as Google leaves it out.
 */
function fakeGoogleSeries(options: { start?: string; end?: string; timeZone?: string; description?: string; location?: string; attendees?: Attendee[]; reminders?: Reminders; failReadBack?: boolean } = {}) {
  const master = {
    id: MASTER,
    summary: 'Rebel: Tuesday session',
    description: options.description,
    location: options.location,
    attendees: options.attendees,
    reminders: options.reminders,
    recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261224T235959Z'],
    start: { dateTime: options.start ?? '2026-12-01T09:30:00Z', timeZone: options.timeZone ?? 'Europe/London' } as Slot,
    end: { dateTime: options.end ?? '2026-12-01T10:00:00Z', timeZone: options.timeZone ?? 'Europe/London' } as Slot,
  };
  let seriesChanged = false;
  let entryWrites = 0;
  let overrides = new Map<string, Override>();
  const until = Date.parse('2026-12-24T23:59:59Z');

  const instances = (showDeleted: boolean) => {
    const length = Date.parse(master.end.dateTime) - Date.parse(master.start.dateTime);
    const out: Array<Record<string, unknown>> = [];
    for (let at = Date.parse(master.start.dateTime); at <= until; at += WEEK_MS) {
      const original = new Date(at).toISOString().replace('.000', '');
      const change = overrides.get(original) ?? {};
      if (change.status === 'cancelled' && !showDeleted) continue;
      out.push({
        id: `${MASTER}_${compact(original)}`,
        recurringEventId: MASTER,
        status: change.status ?? 'confirmed',
        summary: change.summary ?? master.summary,
        description: change.description === '' ? undefined : change.description ?? master.description,
        location: change.location ?? master.location,
        attendees: change.attendees ?? master.attendees,
        reminders: change.reminders ?? master.reminders,
        originalStartTime: { dateTime: original, timeZone: master.start.timeZone },
        start: change.start ?? { dateTime: original, timeZone: master.start.timeZone },
        end: change.end ?? { dateTime: new Date(at + length).toISOString().replace('.000', ''), timeZone: master.start.timeZone },
      });
    }
    return out;
  };
  const instanceById = (id: string) => instances(true).find(entry => entry.id === id);
  const originalOf = (entry: Record<string, unknown>) => (entry.originalStartTime as Slot).dateTime;

  /** The person's own changes, made in Google Calendar before Rebel's call. */
  const personChanges = () => {
    overrides.set('2026-12-08T09:30:00Z', { start: { dateTime: '2026-12-08T11:00:00Z' }, end: { dateTime: '2026-12-08T11:30:00Z' } });
    overrides.set('2026-12-15T09:30:00Z', { status: 'cancelled' });
    overrides.set('2026-12-22T09:30:00Z', { summary: 'Rebel: Tuesday session (with Priya)' });
  };

  mswServer.use(
    http.get(`${CALENDARS_ROOT}/:calendarId/events/:eventId/instances`, ({ params, request }) => {
      if (params.eventId !== MASTER) return new HttpResponse(null, { status: 404 });
      if (options.failReadBack && seriesChanged) return new HttpResponse(null, { status: 403 });
      const query = new URL(request.url).searchParams;
      let items = instances(query.get('showDeleted') === 'true');
      const originalStart = query.get('originalStart');
      if (originalStart) items = items.filter(entry => Date.parse(originalOf(entry)) === Date.parse(originalStart));
      const timeMin = query.get('timeMin');
      const timeMax = query.get('timeMax');
      if (timeMin) items = items.filter(entry => Date.parse((entry.end as Slot).dateTime) > Date.parse(timeMin));
      if (timeMax) items = items.filter(entry => Date.parse((entry.start as Slot).dateTime) < Date.parse(timeMax));
      return HttpResponse.json({ items });
    }),
    http.get(`${CALENDARS_ROOT}/:calendarId/events/:eventId`, ({ params }) => {
      const id = String(params.eventId);
      if (id === MASTER) return HttpResponse.json(master);
      const entry = instanceById(id);
      return entry ? HttpResponse.json(entry) : new HttpResponse(null, { status: 404 });
    }),
    http.patch(`${CALENDARS_ROOT}/:calendarId/events/:eventId`, async ({ params, request }) => {
      const id = String(params.eventId);
      const body = await request.json() as { start?: Slot; end?: Slot; summary?: string; description?: string; location?: string; attendees?: Attendee[]; reminders?: Reminders; status?: string };
      if (id === MASTER) {
        // Google: a new series time, or a new zone for its repeats, leaves every single-entry change behind.
        if (body.start && (instantOf(body.start) !== Date.parse(master.start.dateTime)
          || (body.start.timeZone !== undefined && body.start.timeZone !== master.start.timeZone))) {
          overrides = new Map();
        }
        if (body.start) master.start = utc(body.start, master.start.timeZone!);
        if (body.end) master.end = utc(body.end, master.end.timeZone!);
        if (body.summary !== undefined) master.summary = body.summary;
        seriesChanged = true;
        return HttpResponse.json({ ...master, htmlLink: 'https://calendar.google.com/event?eid=x' });
      }
      const entry = instanceById(id);
      if (!entry) return new HttpResponse(null, { status: 404 });
      entryWrites += 1;
      const original = originalOf(entry);
      const change = { ...overrides.get(original) };
      if (body.start) change.start = body.start;
      if (body.end) change.end = body.end;
      if (body.summary !== undefined) change.summary = body.summary;
      if (body.description !== undefined) change.description = body.description;
      if (body.location !== undefined) change.location = body.location;
      if (body.attendees !== undefined) change.attendees = body.attendees;
      if (body.reminders !== undefined) change.reminders = mergePatch(entry.reminders, body.reminders) as Reminders;
      if (body.status === 'cancelled') change.status = 'cancelled';
      overrides.set(original, change);
      return HttpResponse.json({ ...instanceById(id), htmlLink: 'https://calendar.google.com/event?eid=y' });
    }),
    http.delete(`${CALENDARS_ROOT}/:calendarId/events/:eventId`, ({ params }) => {
      const entry = instanceById(String(params.eventId));
      if (!entry) return new HttpResponse(null, { status: 404 });
      entryWrites += 1;
      overrides.set(originalOf(entry), { ...overrides.get(originalOf(entry)), status: 'cancelled' });
      return new HttpResponse(null, { status: 204 });
    }),
  );

  /** What their calendar shows now, by original start: the time each entry is at, its title and any note. */
  const shown = () => Object.fromEntries(instances(false).map(entry => [
    (entry.originalStartTime as Slot).dateTime.slice(0, 10),
    `${(entry.start as Slot).dateTime.slice(11, 16)} ${String(entry.summary)}${entry.description ? ` / ${String(entry.description)}` : ''}`,
  ]));
  /** A change made by hand to the entry whose original start is given. */
  const change = (originalStart: string, override: Override) => overrides.set(originalStart, override);
  /** The entry shown on a date, with every field. */
  const entryOn = (date: string) => instances(false).find(entry => originalOf(entry).startsWith(date));
  return { personChanges, shown, change, entryOn, entryWrites: () => entryWrites };
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('changing a repeating series keeps the person\'s single-entry changes', () => {
  it('moves the series to 10:30 and keeps the entry they moved, the one they deleted and the one they renamed', async () => {
    const calendar = fakeGoogleSeries();
    calendar.personChanges();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T10:30:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-12-01T11:00:00Z', timeZone: 'Europe/London' } }],
    });

    expect(response.isError).toBeFalsy();
    expect(calendar.shown()).toEqual({
      '2026-12-01': '10:30 Rebel: Tuesday session',
      '2026-12-08': '11:00 Rebel: Tuesday session',
      '2026-12-22': '10:30 Rebel: Tuesday session (with Priya)',
    });
  });

  it('says which of their single-entry changes it kept, so the reply can tell them', async () => {
    const calendar = fakeGoogleSeries();
    calendar.personChanges();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T10:30:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-12-01T11:00:00Z', timeZone: 'Europe/London' } }],
    });

    const text = response.content[0].text;
    for (const date of ['2026-12-08', '2026-12-15', '2026-12-22']) expect(text).toContain(date);
  });

  it('moving the series to another day says which single-entry changes it could not keep', async () => {
    const calendar = fakeGoogleSeries();
    calendar.personChanges();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-02T09:30:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-12-02T10:00:00Z', timeZone: 'Europe/London' } }],
    });

    expect(response.isError).toBeFalsy();
    const notKept = response.content[0].text.split('singleEntryChangesNotKept')[1] ?? '';
    for (const date of ['2026-12-08', '2026-12-15', '2026-12-22']) expect(notKept).toContain(date);
    expect(response.content[0].text).not.toContain('singleEntryChangesKept');
  });

  it('changes a series with no single-entry changes exactly as before', async () => {
    const calendar = fakeGoogleSeries();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T10:30:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-12-01T11:00:00Z', timeZone: 'Europe/London' } }],
    });

    expect(response.isError).toBeFalsy();
    expect(Object.values(calendar.shown())).toEqual([
      '10:30 Rebel: Tuesday session', '10:30 Rebel: Tuesday session', '10:30 Rebel: Tuesday session', '10:30 Rebel: Tuesday session',
    ]);
  });

  it('matches entries by their date in the series\' own zone, not in UTC', async () => {
    // Tuesdays 08:30 in Tokyo are Mondays 23:30 in UTC; moved to 09:30 they are Tuesdays 00:30 in UTC.
    const calendar = fakeGoogleSeries({ start: '2026-11-30T23:30:00Z', end: '2026-12-01T00:00:00Z', timeZone: 'Asia/Tokyo' });
    calendar.change('2026-12-07T23:30:00Z', { status: 'cancelled' });
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T09:30:00+09:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-12-01T10:00:00+09:00', timeZone: 'Asia/Tokyo' } }],
    });

    expect(response.isError).toBeFalsy();
    expect(Object.keys(calendar.shown())).toEqual(['2026-12-01', '2026-12-15', '2026-12-22']);
    expect(response.content[0].text).not.toContain('singleEntryChangesNotKept');
  });

  it('says plainly which changes it could not keep when the entries cannot be read back after the change', async () => {
    const calendar = fakeGoogleSeries({ failReadBack: true });
    calendar.personChanges();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T10:30:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-12-01T11:00:00Z', timeZone: 'Europe/London' } }],
    });

    expect(response.isError).toBeFalsy();
    const text = response.content[0].text;
    expect(text).toContain('singleEntryChangesNotKept');
    for (const date of ['2026-12-08', '2026-12-15', '2026-12-22']) expect(text).toContain(date);
    expect(text).not.toContain('singleEntryChangesKept');
  });

  it('puts back a note cleared on one entry, and keeps a new series title on an entry whose note alone was edited', async () => {
    const calendar = fakeGoogleSeries({ description: 'Series notes' });
    calendar.change('2026-12-08T09:30:00Z', { description: '' });
    calendar.change('2026-12-15T09:30:00Z', { description: 'Bring the deck' });
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      summary: 'Rebel: Tuesday focus',
      new_times: [{ start: { dateTime: '2026-12-01T10:30:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-12-01T11:00:00Z', timeZone: 'Europe/London' } }],
    });

    expect(response.isError).toBeFalsy();
    expect(calendar.shown()).toEqual({
      '2026-12-01': '10:30 Rebel: Tuesday focus / Series notes',
      '2026-12-08': '10:30 Rebel: Tuesday focus',
      '2026-12-15': '10:30 Rebel: Tuesday focus / Bring the deck',
      '2026-12-22': '10:30 Rebel: Tuesday focus / Series notes',
    });
  });

  it('keeps every change and reports it kept when the time given is the series\' time written without an offset', async () => {
    const calendar = fakeGoogleSeries();
    calendar.personChanges();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T09:30:00', timeZone: 'Europe/London' }, end: { dateTime: '2026-12-01T10:00:00', timeZone: 'Europe/London' } }],
    });

    expect(response.isError).toBeFalsy();
    expect(calendar.shown()).toEqual({
      '2026-12-01': '09:30 Rebel: Tuesday session',
      '2026-12-08': '11:00 Rebel: Tuesday session',
      '2026-12-22': '09:30 Rebel: Tuesday session (with Priya)',
    });
    expect(response.content[0].text).not.toContain('singleEntryChangesNotKept');
    expect(calendar.entryWrites()).toBe(0);
  });

  it('treats a time written without an offset as in its own zone when deciding whether the series moved', async () => {
    // 09:30 in Tokyo is 00:30 UTC: a real move for a series at 09:30 UTC, though the written times look alike.
    // On a machine in UTC, reading the written time as the machine's own would call them the same.
    vi.stubEnv('TZ', 'UTC');
    const calendar = fakeGoogleSeries();
    calendar.personChanges();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T09:30:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-12-01T10:00:00', timeZone: 'Asia/Tokyo' } }],
    });

    expect(response.isError).toBeFalsy();
    expect(calendar.shown()).toEqual({
      '2026-12-01': '00:30 Rebel: Tuesday session',
      '2026-12-08': '11:00 Rebel: Tuesday session',
      '2026-12-22': '00:30 Rebel: Tuesday session (with Priya)',
    });
  });

  it('keeps every change when only the zone the series repeats in changes, at the same first moment', async () => {
    // 09:30 London is 18:30 Tokyo in winter; the repeats now follow Tokyo's clock, so Google re-keys them.
    const calendar = fakeGoogleSeries();
    calendar.personChanges();
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T18:30:00+09:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-12-01T19:00:00+09:00', timeZone: 'Asia/Tokyo' } }],
    });

    expect(response.isError).toBeFalsy();
    expect(calendar.shown()).toEqual({
      '2026-12-01': '09:30 Rebel: Tuesday session',
      '2026-12-08': '11:00 Rebel: Tuesday session',
      '2026-12-22': '09:30 Rebel: Tuesday session (with Priya)',
    });
    expect(response.content[0].text).not.toContain('singleEntryChangesNotKept');
  });

  it('matches entries by their date in the series\' new zone when the change moves it to another zone', async () => {
    // Tuesdays 08:30 in Tokyo become Tuesdays 08:30 in Los Angeles: in Tokyo's clock those fall on Wednesdays.
    const calendar = fakeGoogleSeries({ start: '2026-11-30T23:30:00Z', end: '2026-12-01T00:00:00Z', timeZone: 'Asia/Tokyo' });
    calendar.change('2026-12-07T23:30:00Z', { status: 'cancelled' });
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T08:30:00-08:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-12-01T09:00:00-08:00', timeZone: 'America/Los_Angeles' } }],
    });

    expect(response.isError).toBeFalsy();
    expect(Object.keys(calendar.shown())).toEqual(['2026-12-01', '2026-12-15', '2026-12-22']);
    expect(response.content[0].text).not.toContain('singleEntryChangesNotKept');
  });

  it('keeps a changed place, says which entries\' guest changes it did not carry over, and ignores a guest\'s own reply', async () => {
    const team = [{ email: EMAIL, responseStatus: 'accepted' }, { email: 'guest@example.com', responseStatus: 'needsAction' }];
    const calendar = fakeGoogleSeries({ location: 'Room A', attendees: team });
    calendar.change('2026-12-08T09:30:00Z', { summary: 'Rebel: Tuesday session (with Priya)', location: 'Room B', attendees: [...team, { email: 'priya@example.com' }] });
    calendar.change('2026-12-15T09:30:00Z', { attendees: [...team, { email: 'sam@example.com', optional: true }] });
    calendar.change('2026-12-22T09:30:00Z', { attendees: [team[0], { email: 'guest@example.com', responseStatus: 'declined' }] });
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T10:30:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-12-01T11:00:00Z', timeZone: 'Europe/London' } }],
    });

    expect(response.isError).toBeFalsy();
    const guests = (date: string) => (calendar.entryOn(date)?.attendees as Attendee[]).map(guest => guest.email);
    expect(calendar.entryOn('2026-12-08')).toMatchObject({ summary: 'Rebel: Tuesday session (with Priya)', location: 'Room B' });
    // Guests are never written back: that would add someone to a meeting without telling them.
    expect(guests('2026-12-08')).not.toContain('priya@example.com');
    expect(guests('2026-12-15')).not.toContain('sam@example.com');
    const result = JSON.parse(response.content[0].text) as { singleEntryChangesNotKept?: Array<{ date: string; reason: string }> };
    const untagged = (value: string) => value.replace(/<[^>]+>/g, '');
    const notKept = Object.fromEntries((result.singleEntryChangesNotKept ?? []).map(item => [untagged(item.date), untagged(item.reason)]));
    expect(notKept['2026-12-08']).toContain('attendees');
    expect(notKept['2026-12-15']).toContain('attendees');
    expect(response.content[0].text).not.toContain('2026-12-22');
  });

  it('says a reminder change on one entry was not carried over, and leaves the series\' reminders on it', async () => {
    const calendar = fakeGoogleSeries({ reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] } });
    calendar.change('2026-12-08T09:30:00Z', { reminders: { useDefault: false } });
    const call = await loadServer();

    const response = await call('manage_workspace_calendar_event', {
      event_id: MASTER,
      action: 'update_time',
      new_times: [{ start: { dateTime: '2026-12-01T10:30:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-12-01T11:00:00Z', timeZone: 'Europe/London' } }],
    });

    expect(response.isError).toBeFalsy();
    expect(calendar.entryOn('2026-12-08')?.reminders).toEqual({ useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] });
    const result = JSON.parse(response.content[0].text) as { singleEntryChangesNotKept?: Array<{ date: string; reason: string }> };
    expect(result.singleEntryChangesNotKept).toEqual([expect.objectContaining({ date: expect.stringContaining('2026-12-08'), reason: expect.stringContaining('reminders') })]);
  });
});
