/**
 * CalDAV transport, discovery, and iCalendar parsing.
 *
 * `fetch` is stubbed rather than routed through msw so each test can assert on
 * the exact request (method, Depth header, Authorization, URL) and on redirect
 * handling, which is a security boundary here: credentials must never leave the
 * configured origin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertHttpsUrl,
  caldavRequest,
  CALDAV_MAX_RESPONSE_BYTES,
} from '../src/caldav/http.js';
import { discoverCalendars, queryCalendarEvents, resetCalDavDiscoveryCache } from '../src/caldav/client.js';
import { parseVEvents, unfoldIcal, unescapeIcalText, parseIcalDuration } from '../src/caldav/ical.js';
import { parseXml, descendantNamed, descendantsNamed } from '../src/caldav/xml.js';

const CREDENTIALS = { email: 'jane@example.com', password: 'app-specific-password' };
const BASE = 'https://caldav.example.com/principals/users/';

/** Alibaba-shaped discovery answer: uppercase `D:`/`C:` prefixes. */
const DISCOVERY_UPPERCASE = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/principals/users/</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal><D:href>/principals/users/jane@example.com/</D:href></D:current-user-principal>
        <C:calendar-home-set><D:href>/principals/users/jane@example.com/events/</D:href></C:calendar-home-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

/** The home is itself the one calendar collection (Alibaba's shape). */
const HOME_UPPERCASE = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/principals/users/jane@example.com/events/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>jane@example.com</D:displayname>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

/** Same information with lowercase `d:`/`cal:` prefixes and no comp set. */
const DISCOVERY_LOWERCASE = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/principals/users/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal><d:href>/principals/users/jane@example.com/</d:href></d:current-user-principal>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

const HOME_SET_LOWERCASE = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/principals/users/jane@example.com/</d:href>
    <d:propstat>
      <d:prop><cal:calendar-home-set><d:href>/calendars/jane/</d:href></cal:calendar-home-set></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

const COLLECTIONS_LOWERCASE = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/jane/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/calendars/jane/work/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Work</d:displayname>
        <cal:calendar-description>Team meetings</cal:calendar-description>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/calendars/jane/tasks/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

let fetchMock: ReturnType<typeof vi.fn>;
/** Every request the code under test issued, in order. */
let calls: Array<{ url: string; method: string; depth?: string; auth?: string; body?: string }>;

function stubFetch(responses: StubResponse[]): void {
  let index = 0;
  fetchMock.mockImplementation(async (input: URL | string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      depth: headers.Depth,
      auth: headers.Authorization,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(next.body ?? '', {
      status: next.status ?? 207,
      headers: next.headers,
    });
  });
}

beforeEach(() => {
  calls = [];
  resetCalDavDiscoveryCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCalDavDiscoveryCache();
});

describe('assertHttpsUrl', () => {
  it('refuses an http:// endpoint rather than downgrading', () => {
    expect(() => assertHttpsUrl('http://caldav.example.com/', 'EMAIL_IMAP_CALDAV_URL')).toThrow(
      /https:\/\//,
    );
  });

  it('refuses an unparseable URL', () => {
    expect(() => assertHttpsUrl('not a url', 'EMAIL_IMAP_CALDAV_URL')).toThrow(/not a valid URL/);
  });

  it('strips userinfo so the password cannot leak into an error message', () => {
    const url = assertHttpsUrl('https://jane:secret@caldav.example.com/dav/', 'X');
    expect(url.href).toBe('https://caldav.example.com/dav/');
    expect(url.href).not.toContain('secret');
  });
});

describe('caldavRequest redirects', () => {
  it('follows a same-origin redirect and strips userinfo from the Location', async () => {
    stubFetch([
      {
        status: 301,
        headers: { location: 'https://jane:secret@caldav.example.com/dav/principals/' },
      },
      { status: 207, body: DISCOVERY_UPPERCASE },
    ]);

    const response = await caldavRequest(
      new URL(BASE),
      { method: 'PROPFIND', depth: '0', body: '<x/>' },
      CREDENTIALS,
    );

    expect(response.status).toBe(207);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://caldav.example.com/dav/principals/');
    expect(calls[1].url).not.toContain('secret');
    // Method and body survive the redirect: a PROPFIND that became a GET would
    // answer a different question.
    expect(calls[1].method).toBe('PROPFIND');
    expect(calls[1].body).toBe('<x/>');
  });

  it('refuses a cross-origin redirect instead of replaying the password', async () => {
    stubFetch([{ status: 302, headers: { location: 'https://evil.example.net/dav/' } }]);

    await expect(
      caldavRequest(new URL(BASE), { method: 'PROPFIND', depth: '0' }, CREDENTIALS),
    ).rejects.toThrow(/different host \(evil\.example\.net\)/);
    // The credentials were sent exactly once — to the configured origin.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(BASE);
  });

  it('stops after three redirects', async () => {
    stubFetch([{ status: 307, headers: { location: 'https://caldav.example.com/loop/' } }]);
    await expect(
      caldavRequest(new URL(BASE), { method: 'PROPFIND', depth: '0' }, CREDENTIALS),
    ).rejects.toThrow(/kept redirecting/);
  });

  it('sends Basic auth and the Depth header', async () => {
    stubFetch([{ status: 207, body: DISCOVERY_UPPERCASE }]);
    await caldavRequest(new URL(BASE), { method: 'PROPFIND', depth: '1' }, CREDENTIALS);
    expect(calls[0].depth).toBe('1');
    expect(calls[0].auth).toBe(
      `Basic ${Buffer.from('jane@example.com:app-specific-password').toString('base64')}`,
    );
  });

  it('refuses a body larger than the cap', async () => {
    const oversized = 'x'.repeat(CALDAV_MAX_RESPONSE_BYTES + 1024);
    stubFetch([{ status: 207, body: oversized }]);
    await expect(
      caldavRequest(new URL(BASE), { method: 'PROPFIND', depth: '0' }, CREDENTIALS),
    ).rejects.toThrow(/stopped reading it/);
  });
});

describe('discoverCalendars', () => {
  it('reads an Alibaba-shaped answer where the home is itself the calendar', async () => {
    stubFetch([{ body: DISCOVERY_UPPERCASE }, { body: HOME_UPPERCASE }]);

    const discovery = await discoverCalendars(new URL(BASE), CREDENTIALS);

    expect(discovery.home).toBe('https://caldav.example.com/principals/users/jane@example.com/events/');
    expect(discovery.calendars).toHaveLength(1);
    expect(discovery.calendars[0]).toMatchObject({
      href: 'https://caldav.example.com/principals/users/jane@example.com/events/',
      displayName: 'jane@example.com',
    });
  });

  it('reads a lowercase-prefix server, chasing the principal for the home', async () => {
    stubFetch([
      { body: DISCOVERY_LOWERCASE },
      { body: HOME_SET_LOWERCASE },
      { body: COLLECTIONS_LOWERCASE },
    ]);

    const discovery = await discoverCalendars(new URL(BASE), CREDENTIALS);

    // The plain collection is skipped (no `calendar` resourcetype) and so is the
    // VTODO-only collection; only the VEVENT calendar survives.
    expect(discovery.calendars).toHaveLength(1);
    expect(discovery.calendars[0]).toMatchObject({
      href: 'https://caldav.example.com/calendars/jane/work/',
      displayName: 'Work',
      description: 'Team meetings',
    });
  });

  it('caches discovery per account', async () => {
    stubFetch([{ body: DISCOVERY_UPPERCASE }, { body: HOME_UPPERCASE }]);
    await discoverCalendars(new URL(BASE), CREDENTIALS);
    const after = calls.length;
    await discoverCalendars(new URL(BASE), CREDENTIALS);
    expect(calls.length).toBe(after);
  });

  it('reports a login failure for 401 without naming the password', async () => {
    stubFetch([{ status: 401, body: 'Unauthorized' }]);

    const error = await discoverCalendars(new URL(BASE), CREDENTIALS).catch(
      (caught: unknown) => caught as Error & { code?: string; resolution?: string },
    );

    expect(error.message).toMatch(/rejected the login \(HTTP 401\)/);
    expect(error.code).toBe('CALDAV_AUTH_FAILED');
    // The message names the region as a cause, because an Alibaba account only
    // authenticates against its own regional host.
    expect(error.resolution).toMatch(/regional/);
    expect(`${error.message}${error.resolution ?? ''}`).not.toContain(CREDENTIALS.password);
  });

  it('fails loud when the endpoint answers with something that is not a multistatus', async () => {
    stubFetch([{ status: 200, body: '<html><body>Please sign in</body></html>' }]);
    await expect(discoverCalendars(new URL(BASE), CREDENTIALS)).rejects.toThrow(
      /not a WebDAV multistatus/,
    );
  });
});

describe('queryCalendarEvents', () => {
  const EVENT_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/principals/users/jane@example.com/events/1.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"etag-1"</D:getetag>
        <C:calendar-data>BEGIN:VCALENDAR&#13;&#10;BEGIN:VEVENT&#13;&#10;UID:1&#13;&#10;DTSTART:20261005T090000Z&#13;&#10;END:VEVENT&#13;&#10;END:VCALENDAR</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

  const WORK_CALENDAR = new URL('https://caldav.example.com/calendars/jane/work/');
  const RANGE_START = new Date('2026-10-01T00:00:00Z');
  const RANGE_END = new Date('2026-10-08T00:00:00Z');

  /**
   * A 403 that carries the `DAV:error` precondition body RFC 4918 §16 requires —
   * the shape that means "I refuse that request element", not "wrong password".
   */
  const FORBIDDEN_WITH_DAV_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:supported-filter/></D:error>`;

  /**
   * Request bodies are asserted through the local-name reader rather than as
   * literal text: the namespace PREFIX is this connector's own choice, a server
   * reads the resolved element name, and pinning the prefix tests cosmetics.
   */
  function requestElement(body: string | undefined, name: string) {
    return descendantNamed(parseXml(body ?? ''), name);
  }

  it('asks the server to expand recurrences and reports success', async () => {
    stubFetch([{ body: EVENT_REPORT }]);
    const result = await queryCalendarEvents(
      WORK_CALENDAR,
      RANGE_START,
      RANGE_END,
      CREDENTIALS,
    );

    expect(calls[0].method).toBe('REPORT');
    expect(requestElement(calls[0].body, 'expand')?.attrs).toMatchObject({
      start: '20261001T000000Z',
      end: '20261008T000000Z',
    });
    expect(requestElement(calls[0].body, 'time-range')?.attrs).toMatchObject({
      start: '20261001T000000Z',
      end: '20261008T000000Z',
    });
    expect(result.expanded).toBe(true);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].etag).toBe('"etag-1"');
  });

  it('retries without expand when the server refuses it, and flags it', async () => {
    stubFetch([{ status: 400, body: '<D:error xmlns:D="DAV:"/>' }, { body: EVENT_REPORT }]);
    const result = await queryCalendarEvents(
      WORK_CALENDAR,
      RANGE_START,
      RANGE_END,
      CREDENTIALS,
    );

    expect(result.expanded).toBe(false);
    expect(calls).toHaveLength(2);
    // calendar-data is still requested — just with no expand child inside it.
    expect(requestElement(calls[1].body, 'expand')).toBeUndefined();
    expect(requestElement(calls[1].body, 'calendar-data')?.children).toEqual([]);
  });

  it('treats a 403 carrying a DAV:error body as a refused expand, not a login failure', async () => {
    stubFetch([{ status: 403, body: FORBIDDEN_WITH_DAV_ERROR }, { body: EVENT_REPORT }]);
    const result = await queryCalendarEvents(
      WORK_CALENDAR,
      RANGE_START,
      RANGE_END,
      CREDENTIALS,
    );

    expect(result.expanded).toBe(false);
    expect(result.resources).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(requestElement(calls[1].body, 'expand')).toBeUndefined();
  });

  it('treats a bare 403 as a login failure instead of retrying without expand', async () => {
    stubFetch([{ status: 403, body: '' }]);

    const error = await queryCalendarEvents(
      WORK_CALENDAR,
      RANGE_START,
      RANGE_END,
      CREDENTIALS,
    ).catch((caught: unknown) => caught as Error & { code?: string });

    expect(error.code).toBe('CALDAV_AUTH_FAILED');
    expect(error.message).toMatch(/rejected the login \(HTTP 403\)/);
    // No retry: a password the server rejected would only be sent a second time.
    expect(calls).toHaveLength(1);
  });

  it('treats a 403 whose body is an error page, not a DAV:error, as a login failure', async () => {
    stubFetch([{ status: 403, body: '<html><body>Forbidden</body></html>' }]);

    const error = await queryCalendarEvents(
      WORK_CALENDAR,
      RANGE_START,
      RANGE_END,
      CREDENTIALS,
    ).catch((caught: unknown) => caught as Error & { code?: string });

    expect(error.code).toBe('CALDAV_AUTH_FAILED');
    expect(calls).toHaveLength(1);
  });

  it('reports the bytes it read, including a retry after a refused expand', async () => {
    stubFetch([{ status: 400, body: '<D:error xmlns:D="DAV:"/>' }, { body: EVENT_REPORT }]);
    const result = await queryCalendarEvents(
      WORK_CALENDAR,
      RANGE_START,
      RANGE_END,
      CREDENTIALS,
    );

    expect(result.bytes).toBe(
      Buffer.byteLength('<D:error xmlns:D="DAV:"/>', 'utf8') +
        Buffer.byteLength(EVENT_REPORT, 'utf8'),
    );
  });
});

describe('iCalendar parsing', () => {
  it('unfolds RFC 5545 continuation lines', () => {
    expect(unfoldIcal('SUMMARY:Quarterly\r\n  review\r\nUID:1')).toEqual([
      'SUMMARY:Quarterly review',
      'UID:1',
    ]);
  });

  it('unescapes TEXT values', () => {
    expect(unescapeIcalText('Line one\\nLine two\\, and\\; more\\\\')).toBe(
      'Line one\nLine two, and; more\\',
    );
  });

  it('parses durations and rejects malformed ones', () => {
    expect(parseIcalDuration('PT1H30M')).toBe(5_400_000);
    expect(parseIcalDuration('P1D')).toBe(86_400_000);
    expect(parseIcalDuration('1 hour')).toBeNull();
  });

  it('parses a UTC event with folded and escaped text, and strips mailto', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:evt-1',
      'SUMMARY:Quarterly',
      '  review',
      'DESCRIPTION:Bring numbers\\, slides\\nand coffee',
      'LOCATION:Room 4',
      'DTSTART:20261005T090000Z',
      'DTEND:20261005T100000Z',
      'STATUS:CONFIRMED',
      'ORGANIZER;CN=Jane Doe:mailto:jane@example.com',
      'ATTENDEE;CN=Sam Smith;PARTSTAT=ACCEPTED:mailto:sam@example.com',
      'URL:https://example.com/evt-1',
      'BEGIN:VALARM',
      'DESCRIPTION:Reminder that must not overwrite the event',
      'DURATION:-PT15M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const { events, unparseable } = parseVEvents(ical);

    expect(unparseable).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: 'evt-1',
      summary: 'Quarterly review',
      description: 'Bring numbers, slides\nand coffee',
      location: 'Room 4',
      start: { dateTime: '2026-10-05T09:00:00Z' },
      end: { dateTime: '2026-10-05T10:00:00Z' },
      status: 'CONFIRMED',
      organizer: 'Jane Doe <jane@example.com>',
      recurring: false,
      url: 'https://example.com/evt-1',
    });
    expect(events[0].attendees).toEqual([
      { email: 'sam@example.com', name: 'Sam Smith', status: 'ACCEPTED' },
    ]);
  });

  it('parses an all-day event as a date', () => {
    const ical =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261013\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const { events } = parseVEvents(ical);
    expect(events[0].start).toEqual({ date: '2026-10-12' });
    expect(events[0].end).toEqual({ date: '2026-10-13' });
  });

  it('reports a TZID value as local wall time plus the zone, not shifted', () => {
    const ical =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART;TZID=Asia/Shanghai:20261005T093000\r\nDURATION:PT45M\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const { events } = parseVEvents(ical);
    expect(events[0].start).toEqual({ dateTime: '2026-10-05T09:30:00', timeZone: 'Asia/Shanghai' });
    expect(events[0].end).toEqual({ dateTime: '2026-10-05T10:15:00', timeZone: 'Asia/Shanghai' });
  });

  it('flags an unexpanded recurring event instead of inventing instances', () => {
    const ical =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Standup\r\nDTSTART:20261005T090000Z\r\nRRULE:FREQ=WEEKLY;COUNT=10\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const { events } = parseVEvents(ical);
    expect(events[0].recurring).toBe(true);
    expect(events[0].start).toEqual({ dateTime: '2026-10-05T09:00:00Z' });
  });

  it('counts a VEVENT with an unreadable DTSTART rather than dropping it silently', () => {
    const ical =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d\r\nDTSTART:not-a-date\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const { events, unparseable } = parseVEvents(ical);
    expect(events).toHaveLength(0);
    expect(unparseable).toBe(1);
  });

  it('skips VTIMEZONE sub-component properties', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Shanghai',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:e',
      'DTSTART:20261005T090000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const { events, unparseable } = parseVEvents(ical);
    expect(unparseable).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe('e');
  });
});

describe('xml reader', () => {
  it('matches elements by local name regardless of prefix case', () => {
    const upper = descendantsNamed(parseXml(DISCOVERY_UPPERCASE), 'href');
    const lower = descendantsNamed(parseXml(DISCOVERY_LOWERCASE), 'href');
    expect(upper.length).toBeGreaterThan(0);
    expect(lower.length).toBeGreaterThan(0);
  });

  it('decodes only the predefined entities, leaving an unknown one verbatim', () => {
    const root = parseXml(
      '<d:multistatus xmlns:d="DAV:"><d:href>/a&amp;b/</d:href><d:displayname>&xxe;</d:displayname></d:multistatus>',
    );
    expect(descendantsNamed(root, 'href')[0].text).toBe('/a&b/');
    expect(descendantsNamed(root, 'displayname')[0].text).toBe('&xxe;');
  });
});
