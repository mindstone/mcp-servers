/**
 * iCalendar (RFC 5545) VEVENT reader — just enough to describe an event.
 *
 * Deliberate limits:
 *
 *  - Recurrence is not expanded here. `RRULE`/`RDATE` set `recurring: true`
 *    and the raw rule, RDATE/EXDATE values and RECURRENCE-ID are kept on the
 *    event, so `recurrence.ts` can expand the series when the server did not
 *    (Alibaba Mail ignores `CALDAV:expand`).
 *  - No time-zone database. A `TZID` is reported alongside the local wall-clock
 *    value instead of being converted to UTC, so nothing is silently shifted
 *    by an hour. A `DURATION` is added to the wall-clock value, which can be
 *    an hour off across a DST transition — a bounded, documented inaccuracy
 *    rather than a dependency on a 1 MB tz dataset in a published connector.
 *  - VTIMEZONE and VALARM are skipped: a VALARM nests INSIDE a VEVENT and
 *    carries its own DESCRIPTION/DURATION, which would otherwise overwrite the
 *    event's.
 *
 * An event whose DTSTART is missing or unreadable is NOT silently dropped: it
 * is counted in `unparseable` so the tool layer can report it.
 */

/** A date-only or date-time value, shaped like the calendar APIs models know. */
export interface IcalDateValue {
  /** All-day events: `YYYY-MM-DD`. */
  date?: string;
  /** Timed events: `YYYY-MM-DDTHH:MM:SSZ` (UTC) or local wall time. */
  dateTime?: string;
  /** Originating `TZID`, when the value is local wall time in a named zone. */
  timeZone?: string;
}

export interface IcalAttendee {
  /** Address with any `mailto:` prefix removed. */
  email: string;
  /** `CN` parameter, when present. */
  name: string | null;
  /** `PARTSTAT` parameter (ACCEPTED / DECLINED / NEEDS-ACTION / …). */
  status: string | null;
}

export interface IcalEvent {
  uid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: IcalDateValue;
  end: IcalDateValue | null;
  status: string | null;
  /** `Name <address>` or bare address, `mailto:` stripped. */
  organizer: string | null;
  attendees: IcalAttendee[];
  /**
   * True when the event carries its own recurrence rule, i.e. the reported
   * times are the series' first occurrence rather than one instance.
   */
  recurring: boolean;
  /** `URL` property of the event, when present. */
  url: string | null;
  /** Sort key in ms; local/floating values are ordered as if UTC. */
  sortKey: number;
  /** Raw `RRULE` value (first one), when present. */
  rrule: string | null;
  /** `RDATE` values (VALUE=PERIOD entries are skipped and counted in `unsupportedRdates`). */
  rdates: IcalDateValue[];
  /** RDATE entries this reader could not use (periods, malformed values). */
  unsupportedRdates: number;
  /** `EXDATE` values. */
  exdates: IcalDateValue[];
  /** `RECURRENCE-ID`: set on an override instance of a recurring series. */
  recurrenceId: IcalDateValue | null;
}

export interface ParsedVEvents {
  events: IcalEvent[];
  /** VEVENTs skipped because their DTSTART was missing or unreadable. */
  unparseable: number;
}

interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * Undo RFC 5545 §3.1 line folding: a CRLF (or LF) followed by one space or tab
 * is a continuation, and the whitespace itself is not part of the value.
 */
export function unfoldIcal(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const unfolded: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
      continue;
    }
    unfolded.push(line);
  }
  return unfolded.filter((line) => line.length > 0);
}

/**
 * Split `NAME;PARAM=value;PARAM2="with:colon":the value` into its three parts.
 * Only an UNQUOTED colon ends the property name and parameters, so a quoted
 * parameter value may contain `:` and `;`.
 */
function parseContentLine(line: string): ContentLine | null {
  let inQuotes = false;
  let valueStart = -1;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ':' && !inQuotes) {
      valueStart = i;
      break;
    }
  }
  if (valueStart === -1) return null;

  const head = line.slice(0, valueStart);
  const value = line.slice(valueStart + 1);

  const segments: string[] = [];
  let current = '';
  inQuotes = false;
  for (const char of head) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ';' && !inQuotes) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);

  const name = (segments.shift() ?? '').trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    params[segment.slice(0, eq).trim().toUpperCase()] = segment.slice(eq + 1).trim();
  }

  return { name, params, value };
}

/** Unescape an RFC 5545 TEXT value (`\n`, `\,`, `\;`, `\\`). */
export function unescapeIcalText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      out += char;
      continue;
    }
    i += 1;
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === '\\' || next === ',' || next === ';') out += next;
    else out += next;
  }
  return out;
}

const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

interface ParsedDate {
  value: IcalDateValue;
  sortKey: number;
  allDay: boolean;
}

/**
 * Parse a DATE or DATE-TIME property value. Returns `null` for anything that
 * is not a well-formed, in-range iCalendar timestamp — the digits are
 * validated here precisely so the ISO strings this emits are
 * connector-generated and need no untrusted-content envelope.
 */
export function parseIcalDate(line: {
  params: Record<string, string>;
  value: string;
}): ParsedDate | null {
  const raw = line.value.trim();
  const tzid = line.params.TZID?.trim();

  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const ms = utcMs(+y, +m, +d, 0, 0, 0);
    if (ms === null) return null;
    return { value: { date: `${y}-${m}-${d}` }, sortKey: ms, allDay: true };
  }

  const dateTime = DATE_TIME.exec(raw);
  if (dateTime) {
    const [, y, m, d, hh, mm, ss, zulu] = dateTime;
    const ms = utcMs(+y, +m, +d, +hh, +mm, +ss);
    if (ms === null) return null;
    // VALUE=DATE with a time component is contradictory; the time wins,
    // because dropping it would silently turn a meeting into an all-day block.
    const local = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
    if (zulu) {
      return { value: { dateTime: `${local}Z` }, sortKey: ms, allDay: false };
    }
    return {
      value: { dateTime: local, ...(tzid ? { timeZone: tzid } : {}) },
      sortKey: ms,
      allDay: false,
    };
  }

  return null;
}

/** `Date.UTC` with range validation and a round-trip check (rejects Feb 31). */
function utcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  // Leap seconds (`:60`) are clamped rather than rejected: they are legal in
  // RFC 5545 and no JS Date can represent them.
  const ms = Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59));
  const back = new Date(ms);
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return ms;
}

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Parse an RFC 5545 DURATION into milliseconds, or `null` when malformed. */
export function parseIcalDuration(raw: string): number | null {
  const match = DURATION.exec(raw.trim().toUpperCase());
  if (!match) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  if (!weeks && !days && !hours && !minutes && !seconds) return null;
  const ms =
    (Number(weeks ?? 0) * 7 * 86_400 +
      Number(days ?? 0) * 86_400 +
      Number(hours ?? 0) * 3_600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0)) *
    1000;
  return sign === '-' ? -ms : ms;
}

/**
 * Render an end value derived from start + duration, keeping the start's own
 * shape (all-day stays a date; a TZID value stays local wall time in that
 * zone). See the file header on the DST caveat.
 */
function endFromDuration(start: ParsedDate, durationMs: number): IcalDateValue {
  const end = new Date(start.sortKey + durationMs);
  const datePart = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;
  if (start.allDay) return { date: datePart };
  const timePart = `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:${pad(end.getUTCSeconds())}`;
  const zone = start.value.timeZone;
  if (start.value.dateTime?.endsWith('Z')) return { dateTime: `${datePart}T${timePart}Z` };
  return { dateTime: `${datePart}T${timePart}`, ...(zone ? { timeZone: zone } : {}) };
}

function stripMailto(value: string): string {
  return value.trim().replace(/^mailto:/i, '').trim();
}

function formatOrganizer(line: ContentLine): string | null {
  const address = stripMailto(line.value);
  const name = line.params.CN ? unescapeIcalText(line.params.CN).trim() : '';
  if (!address) return name ? name : null;
  return name ? `${name} <${address}>` : address;
}

/**
 * Extract every VEVENT from one (or several concatenated) VCALENDAR objects.
 */
export function parseVEvents(ical: string): ParsedVEvents {
  const lines = unfoldIcal(ical);
  const events: IcalEvent[] = [];
  let unparseable = 0;

  /** Component names from outermost to innermost, e.g. VCALENDAR > VEVENT. */
  const stack: string[] = [];
  let properties: ContentLine[] | null = null;

  for (const line of lines) {
    const parsed = parseContentLine(line);
    if (!parsed) continue;

    if (parsed.name === 'BEGIN') {
      const component = parsed.value.trim().toUpperCase();
      stack.push(component);
      if (component === 'VEVENT' && properties === null) properties = [];
      continue;
    }

    if (parsed.name === 'END') {
      const component = parsed.value.trim().toUpperCase();
      // Tolerate a stray END by only popping a matching component.
      if (stack[stack.length - 1] === component) stack.pop();
      if (component === 'VEVENT' && properties !== null) {
        const event = buildEvent(properties);
        if (event) events.push(event);
        else unparseable += 1;
        properties = null;
      }
      continue;
    }

    // Collect only the VEVENT's own properties: a nested VALARM carries its
    // own DESCRIPTION and DURATION, and VTIMEZONE/STANDARD its own DTSTART.
    if (properties !== null && stack[stack.length - 1] === 'VEVENT') {
      properties.push(parsed);
    }
  }

  return { events, unparseable };
}

function buildEvent(properties: ContentLine[]): IcalEvent | null {
  const first = (name: string): ContentLine | undefined =>
    properties.find((property) => property.name === name);

  const startLine = first('DTSTART');
  if (!startLine) return null;
  const start = parseIcalDate(startLine);
  if (!start) return null;

  let end: IcalDateValue | null = null;
  const endLine = first('DTEND');
  if (endLine) {
    end = parseIcalDate(endLine)?.value ?? null;
  } else {
    const durationLine = first('DURATION');
    const durationMs = durationLine ? parseIcalDuration(durationLine.value) : null;
    if (durationMs !== null) end = endFromDuration(start, durationMs);
  }

  const text = (name: string): string | null => {
    const line = first(name);
    if (!line) return null;
    const value = unescapeIcalText(line.value).trim();
    return value ? value : null;
  };

  const attendees: IcalAttendee[] = [];
  for (const line of properties) {
    if (line.name !== 'ATTENDEE') continue;
    const email = stripMailto(line.value);
    const name = line.params.CN ? unescapeIcalText(line.params.CN).trim() : '';
    if (!email && !name) continue;
    attendees.push({
      email,
      name: name ? name : null,
      status: line.params.PARTSTAT ? line.params.PARTSTAT.trim() : null,
    });
  }

  const organizerLine = first('ORGANIZER');

  // RDATE / EXDATE may repeat and may carry comma-separated lists; each value
  // inherits the line's TZID / VALUE parameters.
  const dateList = (name: string): { values: IcalDateValue[]; rejected: number } => {
    const values: IcalDateValue[] = [];
    let rejected = 0;
    for (const line of properties) {
      if (line.name !== name) continue;
      if (line.params.VALUE?.toUpperCase() === 'PERIOD') {
        rejected += line.value.split(',').length;
        continue;
      }
      for (const part of line.value.split(',')) {
        if (!part.trim()) continue;
        const parsed = parseIcalDate({ params: line.params, value: part });
        if (parsed) values.push(parsed.value);
        else rejected += 1;
      }
    }
    return { values, rejected };
  };
  const rdates = dateList('RDATE');
  const exdates = dateList('EXDATE');
  const recurrenceIdLine = first('RECURRENCE-ID');
  const rruleLine = first('RRULE');

  return {
    uid: text('UID'),
    summary: text('SUMMARY'),
    description: text('DESCRIPTION'),
    location: text('LOCATION'),
    start: start.value,
    end,
    status: text('STATUS'),
    organizer: organizerLine ? formatOrganizer(organizerLine) : null,
    attendees,
    recurring: properties.some((line) => line.name === 'RRULE' || line.name === 'RDATE'),
    url: text('URL'),
    sortKey: start.sortKey,
    rrule: rruleLine ? rruleLine.value.trim() : null,
    rdates: rdates.values,
    unsupportedRdates: rdates.rejected,
    exdates: exdates.values,
    recurrenceId: recurrenceIdLine ? (parseIcalDate(recurrenceIdLine)?.value ?? null) : null,
  };
}
