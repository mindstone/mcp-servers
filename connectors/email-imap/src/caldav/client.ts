/**
 * CalDAV discovery and read-only calendar queries.
 *
 * Discovery follows RFC 6764 / RFC 4791 bottom-up:
 *   PROPFIND Depth 0  →  current-user-principal (and calendar-home-set, which
 *                        several servers volunteer in the same answer)
 *   PROPFIND Depth 0  →  calendar-home-set, when it was not volunteered
 *   PROPFIND Depth 1  →  the collections under the home
 *
 * A "calendar" is any collection whose `resourcetype` includes `calendar` and
 * which either advertises VEVENT support or advertises no component set at
 * all. Alibaba Mail is the awkward shape this was verified against: the
 * calendar home (`/principals/users/<email>/events/`) is ITSELF the single
 * calendar collection, so the Depth 1 answer's own href is the calendar — and
 * a server that answers Depth 1 with nothing calendar-ish gets one more
 * Depth 0 look at the home before the account is reported as having none.
 *
 * Every href the server hands back is re-checked for same-origin before it is
 * used: an href is as server-controlled as a `Location` header, and following
 * one to another host would replay the user's password there.
 */

import { createHash } from 'node:crypto';

import { EmailImapError } from '../types.js';
import {
  assertMultiStatus,
  authError,
  caldavRequest,
  type CalDavCredentials,
  type CalDavResponse,
} from './http.js';
import {
  childNamed,
  childrenNamed,
  descendantNamed,
  descendantsNamed,
  parseXml,
  type XmlElement,
} from './xml.js';
import type { CalDavCalendar, CalDavEventResource } from './types.js';

/**
 * Most calendars queried in one `calendar_list_events` call. Each calendar is
 * one REPORT round-trip, so an account with dozens of subscribed calendars
 * would otherwise turn a single tool call into dozens of requests.
 */
export const MAX_CALENDARS_PER_QUERY = 20;

/**
 * Most REPORT response bytes one `calendar_list_events` call will read across
 * ALL the calendars it queries.
 *
 * `CALDAV_MAX_RESPONSE_BYTES` bounds a single answer (5 MB); without a running
 * total, twenty busy calendars could still stream 100 MB into one tool call.
 * The budget is checked BETWEEN calendars rather than predicted, so the first
 * calendar is always queried and a call reads at most this much plus one more
 * response. Stopping early is reported (`calendarsSkipped` /
 * `responseBudgetExceeded`), never silent.
 */
export const MAX_TOTAL_RESPONSE_BYTES = 10 * 1024 * 1024;

const XML_PROLOG = '<?xml version="1.0" encoding="utf-8"?>';

const PROPFIND_DISCOVERY = `${XML_PROLOG}
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:current-user-principal/>
    <c:calendar-home-set/>
  </d:prop>
</d:propfind>`;

const PROPFIND_HOME_SET = `${XML_PROLOG}
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
  </d:prop>
</d:propfind>`;

const PROPFIND_COLLECTIONS = `${XML_PROLOG}
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:calendar-description/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

/** Statuses that mean "this server does not understand that request element". */
const UNSUPPORTED_REQUEST_STATUSES = new Set([400, 409, 415, 422, 501]);

interface MultiStatusEntry {
  /** Raw href text exactly as the server wrote it. */
  href: string | null;
  /** Successful (2xx propstat) properties, by local element name. */
  props: Map<string, XmlElement>;
}

/**
 * A propstat counts as successful when its status line carries a 2xx code.
 * A propstat with no status at all is treated as successful: RFC 4918 requires
 * one, and refusing the whole response over a missing status would turn a
 * sloppy-but-usable server into "you have no calendars".
 */
function isSuccessfulPropstat(propstat: XmlElement): boolean {
  const status = childNamed(propstat, 'status');
  if (!status) return true;
  return /\s2\d\d\b/.test(status.text);
}

function parseMultiStatus(response: CalDavResponse, operation: string): MultiStatusEntry[] {
  const root = parseXml(response.body);
  const responses = descendantsNamed(root, 'response');
  if (responses.length === 0 && root.name !== 'multistatus') {
    throw new EmailImapError(
      `The calendar server at ${response.url.host} answered ${operation} with a document that is not a WebDAV multistatus.`,
      'CALDAV_BAD_RESPONSE',
      'Confirm EMAIL_IMAP_CALDAV_URL points at a CalDAV endpoint rather than a webmail or login page.',
    );
  }

  return responses.map((entry) => {
    const props = new Map<string, XmlElement>();
    for (const propstat of childrenNamed(entry, 'propstat')) {
      if (!isSuccessfulPropstat(propstat)) continue;
      for (const prop of childrenNamed(propstat, 'prop')) {
        for (const value of prop.children) {
          if (!props.has(value.name)) props.set(value.name, value);
        }
      }
    }
    const href = childNamed(entry, 'href');
    return { href: href ? href.text.trim() : null, props };
  });
}

/**
 * Resolve a server-supplied href against the request URL and refuse one that
 * leaves the origin — the credentials travel with every follow-up request.
 */
function resolveSameOriginHref(base: URL, href: string): URL {
  let resolved: URL;
  try {
    resolved = new URL(href, base);
  } catch {
    throw new EmailImapError(
      `The calendar server at ${base.host} returned a location this connector could not read.`,
      'CALDAV_BAD_RESPONSE',
      'Ask the mail provider for the exact CalDAV endpoint, then set EMAIL_IMAP_CALDAV_URL to it.',
    );
  }
  resolved.username = '';
  resolved.password = '';
  if (resolved.protocol !== 'https:' || resolved.origin !== base.origin) {
    throw new EmailImapError(
      `The calendar server at ${base.host} pointed at a different host (${resolved.host}). ` +
        'The connector refused to follow it, because that would send the calendar password to another server.',
      'CALDAV_CROSS_ORIGIN_HREF',
      `If calendars really live on ${resolved.host}, set EMAIL_IMAP_CALDAV_URL to that host directly.`,
    );
  }
  return resolved;
}

function firstHrefInProp(prop: XmlElement | undefined): string | undefined {
  if (!prop) return undefined;
  const href = descendantNamed(prop, 'href');
  const value = href?.text.trim();
  return value ? value : undefined;
}

async function propfind(
  url: URL,
  depth: '0' | '1',
  body: string,
  credentials: CalDavCredentials,
  operation: string,
): Promise<MultiStatusEntry[]> {
  const response = await caldavRequest(url, { method: 'PROPFIND', depth, body }, credentials);
  assertMultiStatus(response, operation);
  return parseMultiStatus(response, operation);
}

function supportsVEvent(props: Map<string, XmlElement>): boolean {
  const compSet = props.get('supported-calendar-component-set');
  if (!compSet) {
    // No advertised component set — RFC 4791 lets the server omit it, and
    // omitting it means "no restriction", so the collection stays a candidate.
    return true;
  }
  const comps = descendantsNamed(compSet, 'comp');
  if (comps.length === 0) return true;
  return comps.some((comp) => (comp.attrs.name ?? '').toUpperCase() === 'VEVENT');
}

function isCalendarCollection(props: Map<string, XmlElement>): boolean {
  const resourceType = props.get('resourcetype');
  if (!resourceType) return false;
  return resourceType.children.some((child) => child.name === 'calendar');
}

function toCalendar(url: URL, props: Map<string, XmlElement>): CalDavCalendar {
  const displayName = props.get('displayname')?.text.trim();
  const description = props.get('calendar-description')?.text.trim();
  return {
    href: url.href,
    displayName: displayName ? displayName : null,
    description: description ? description : null,
  };
}

export interface CalDavDiscovery {
  /** Calendar home URL the collections were listed from. */
  home: string;
  calendars: CalDavCalendar[];
}

/**
 * Per-process discovery cache. Discovery is three round-trips and its answer
 * does not change between calls in a session; the key includes the account so
 * reconfiguring to another mailbox cannot read a stale home.
 */
let discoveryCache: { key: string; value: CalDavDiscovery } | null = null;

/** Drop the cached discovery (used by tests and after a reconfigure). */
export function resetCalDavDiscoveryCache(): void {
  discoveryCache = null;
}

export async function discoverCalendars(
  base: URL,
  credentials: CalDavCredentials,
): Promise<CalDavDiscovery> {
  // The password is part of the key (as a hash, never stored raw), so a
  // corrected password from configure_email_imap re-runs discovery instead of
  // serving the result of the previous login.
  const fingerprint = createHash('sha256').update(credentials.password).digest('hex');
  const key = `${base.href}|${credentials.email}|${fingerprint}`;
  if (discoveryCache?.key === key) return discoveryCache.value;

  const rootEntries = await propfind(
    base,
    '0',
    PROPFIND_DISCOVERY,
    credentials,
    'calendar discovery',
  );

  let homeHref: string | undefined;
  let principalHref: string | undefined;
  for (const entry of rootEntries) {
    homeHref ??= firstHrefInProp(entry.props.get('calendar-home-set'));
    principalHref ??= firstHrefInProp(entry.props.get('current-user-principal'));
  }

  if (!homeHref && principalHref) {
    const principalUrl = resolveSameOriginHref(base, principalHref);
    const principalEntries = await propfind(
      principalUrl,
      '0',
      PROPFIND_HOME_SET,
      credentials,
      'calendar home lookup',
    );
    for (const entry of principalEntries) {
      homeHref ??= firstHrefInProp(entry.props.get('calendar-home-set'));
    }
  }

  if (!homeHref) {
    throw new EmailImapError(
      `The calendar server at ${base.host} did not report a calendar home for this account.`,
      'CALDAV_NO_CALENDAR_HOME',
      'Check that this mailbox has calendar access enabled, and that EMAIL_IMAP_CALDAV_URL is the ' +
        "provider's CalDAV endpoint (often .../principals/users/).",
    );
  }

  const home = resolveSameOriginHref(base, homeHref);
  const homeEntries = await propfind(
    home,
    '1',
    PROPFIND_COLLECTIONS,
    credentials,
    'calendar listing',
  );

  const calendars: CalDavCalendar[] = [];
  const seen = new Set<string>();
  for (const entry of homeEntries) {
    if (!entry.href) continue;
    if (!isCalendarCollection(entry.props) || !supportsVEvent(entry.props)) continue;
    const url = resolveSameOriginHref(home, entry.href);
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    calendars.push(toCalendar(url, entry.props));
  }

  // Alibaba Mail's calendar home IS the calendar collection, and a Depth 1
  // answer that omits its own href would otherwise look like "no calendars".
  if (calendars.length === 0) {
    const selfEntries = await propfind(
      home,
      '0',
      PROPFIND_COLLECTIONS,
      credentials,
      'calendar home inspection',
    );
    for (const entry of selfEntries) {
      if (!isCalendarCollection(entry.props) || !supportsVEvent(entry.props)) continue;
      const url = entry.href ? resolveSameOriginHref(home, entry.href) : home;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      calendars.push(toCalendar(url, entry.props));
    }
  }

  const value: CalDavDiscovery = { home: home.href, calendars };
  discoveryCache = { key, value };
  return value;
}

/** iCalendar UTC timestamp (`20260302T081500Z`) for a time-range filter. */
export function toIcalUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

function calendarQueryBody(start: Date, end: Date, expand: boolean): string {
  const from = toIcalUtc(start);
  const to = toIcalUtc(end);
  // `expand` asks the server to materialise recurring events as individual
  // instances inside the window, which is the only way to get correct
  // occurrence times without shipping an RRULE engine and a tz database.
  const calendarData = expand
    ? `<c:calendar-data><c:expand start="${from}" end="${to}"/></c:calendar-data>`
    : '<c:calendar-data/>';
  return `${XML_PROLOG}
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    ${calendarData}
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${from}" end="${to}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/**
 * A 403 is ambiguous in WebDAV: it is both "wrong credentials" and "I refuse
 * that request element". RFC 4918 §16 requires the latter to carry a
 * `DAV:error` precondition body, so a 403 WITH one is treated as a protocol
 * refusal (retryable without `expand`) and a bare 403 as an auth failure.
 */
function isPreconditionFailure(response: CalDavResponse): boolean {
  if (!response.body.trim()) return false;
  try {
    const root = parseXml(response.body);
    return root.name === 'error' || descendantNamed(root, 'error') !== undefined;
  } catch {
    return false;
  }
}

export interface CalDavEventQueryResult {
  resources: CalDavEventResource[];
  /** False when the server refused `expand` and recurrences came back raw. */
  expanded: boolean;
  /**
   * Response bytes this query read, including the retry after a refused
   * `expand` — what a caller charges against `MAX_TOTAL_RESPONSE_BYTES`.
   */
  bytes: number;
}

/**
 * Run one `calendar-query` REPORT over a time range against one calendar.
 */
export async function queryCalendarEvents(
  calendar: URL,
  start: Date,
  end: Date,
  credentials: CalDavCredentials,
): Promise<CalDavEventQueryResult> {
  let expanded = true;
  let bytes = 0;
  let response = await caldavRequest(
    calendar,
    { method: 'REPORT', depth: '1', body: calendarQueryBody(start, end, true) },
    credentials,
  );
  bytes += response.bytes;

  const refusedExpand =
    UNSUPPORTED_REQUEST_STATUSES.has(response.status) ||
    (response.status === 403 && isPreconditionFailure(response));

  if (refusedExpand) {
    expanded = false;
    response = await caldavRequest(
      calendar,
      { method: 'REPORT', depth: '1', body: calendarQueryBody(start, end, false) },
      credentials,
    );
    bytes += response.bytes;
  }

  if (response.status === 401 || response.status === 403) {
    throw authError(response.status, response.url.host);
  }
  assertMultiStatus(response, 'the calendar event query');

  const resources: CalDavEventResource[] = [];
  for (const entry of parseMultiStatus(response, 'the calendar event query')) {
    const ical = entry.props.get('calendar-data')?.text;
    if (!ical || !ical.trim()) continue;
    const etag = entry.props.get('getetag')?.text.trim();
    resources.push({
      href: entry.href,
      etag: etag ? etag : null,
      ical,
    });
  }

  return { resources, expanded, bytes };
}
