/**
 * Client-side recurrence expansion for CalDAV servers that do not honour
 * `CALDAV:expand`.
 *
 * Why this exists: Alibaba Mail's CalDAV server ignores the `expand` request
 * and answers a time-range query with the series master (DTSTART + RRULE) for
 * every recurring event — including series that ended long before the range.
 * Without expansion a weekly meeting would be reported once, on its first
 * date, and a finished series would show up in every window.
 *
 * Scope (deliberately bounded, no dependencies):
 *
 *  - FREQ=DAILY | WEEKLY | MONTHLY | YEARLY with INTERVAL, COUNT, UNTIL, WKST,
 *    BYDAY (ordinals for MONTHLY, and for YEARLY together with BYMONTH),
 *    BYMONTHDAY and BYMONTH. RDATE and EXDATE lists. Override instances
 *    (RECURRENCE-ID) are applied by the caller via `occurrenceKey`.
 *  - Expansion runs in the event's own wall-clock time, so a 10:00 meeting stays
 *    at 10:00 local across a DST change; wall time is converted to UTC with the
 *    runtime's ICU time-zone data (`Intl.DateTimeFormat`), not a bundled tz
 *    database.
 *  - Anything else (BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR…, sub-daily FREQ, a
 *    malformed rule) is NOT guessed at: `expandSeries` returns
 *    `{ kind: 'unsupported' }` and the caller reports the master once, flagged.
 *  - Hard bounds: at most `MAX_PERIODS` rule periods per series; a series that
 *    cannot reach the requested range inside that budget is reported as
 *    unsupported rather than silently truncated.
 */

import type { IcalDateValue, IcalEvent } from './ical.js';

const DAY_MS = 86_400_000;
/** Largest UTC offset in either direction (UTC+14 / UTC-12), plus slack. */
const MAX_OFFSET_MS = 15 * 3_600_000;
/** Rule periods walked per series before giving up. */
export const MAX_PERIODS = 2_000;
/** Occurrences emitted per series per call. */
export const MAX_OCCURRENCES_PER_SERIES = 1_000;

// ─── Wall time ────────────────────────────────────────────────────

/**
 * A point in an event's own clock. `wallMs` is `Date.UTC(<local fields>)` — a
 * plain number that does calendar arithmetic without DST effects.
 */
export interface WallTime {
  wallMs: number;
  kind: 'date' | 'utc' | 'floating' | 'zoned';
  /** IANA zone for `kind: 'zoned'`. */
  timeZone?: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z)?$/;

/** Read the connector's own `IcalDateValue` shape back into wall time. */
export function toWall(value: IcalDateValue): WallTime | null {
  if (value.date) {
    const m = ISO_DATE.exec(value.date);
    if (!m) return null;
    return { wallMs: Date.UTC(+m[1], +m[2] - 1, +m[3]), kind: 'date' };
  }
  if (value.dateTime) {
    const m = ISO_DATE_TIME.exec(value.dateTime);
    if (!m) return null;
    const wallMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (m[7]) return { wallMs, kind: 'utc' };
    if (value.timeZone) return { wallMs, kind: 'zoned', timeZone: value.timeZone };
    return { wallMs, kind: 'floating' };
  }
  return null;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Render a wall time in the same shape as `template` (all-day stays a date…). */
export function fromWall(wallMs: number, template: WallTime): IcalDateValue {
  const d = new Date(wallMs);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (template.kind === 'date') return { date };
  const local = `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (template.kind === 'utc') return { dateTime: `${local}Z` };
  if (template.kind === 'zoned' && template.timeZone) {
    return { dateTime: local, timeZone: template.timeZone };
  }
  return { dateTime: local };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    // Throws RangeError for an unknown zone — the caller handles that.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset (local − UTC, in ms) of `timeZone` at the instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour === 24 ? 0 : parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - (utcMs - (utcMs % 1000));
}

/**
 * Convert a local wall-clock time in `timeZone` to a UTC instant.
 *
 * Deterministic at DST edges: in an overlap (the hour that happens twice) the
 * EARLIER instant wins; in a gap (a local time that never happens) the
 * pre-transition offset is used, which lands one gap-length later — the same
 * thing most calendar clients show. Throws `RangeError` for an unknown zone.
 */
export function zonedWallTimeToUtc(wallMs: number, timeZone: string): number {
  const before = zoneOffsetMs(wallMs - DAY_MS, timeZone);
  const after = zoneOffsetMs(wallMs + DAY_MS, timeZone);
  const candidates = [wallMs - before, wallMs - after].filter(
    (candidate) => zoneOffsetMs(candidate, timeZone) === wallMs - candidate,
  );
  if (candidates.length > 0) return Math.min(...candidates);
  return wallMs - before;
}

export interface UtcResolution {
  ms: number;
  /** True when the TZID was not a zone this runtime knows; the time was read as UTC. */
  timeZoneUnknown: boolean;
}

/** UTC instant of a wall time. Dates and floating times are read as UTC. */
export function wallToUtc(wall: WallTime): UtcResolution {
  if (wall.kind !== 'zoned' || !wall.timeZone) return { ms: wall.wallMs, timeZoneUnknown: false };
  try {
    return { ms: zonedWallTimeToUtc(wall.wallMs, wall.timeZone), timeZoneUnknown: false };
  } catch (error) {
    if (error instanceof RangeError) return { ms: wall.wallMs, timeZoneUnknown: true };
    throw error;
  }
}

/**
 * Key that identifies one occurrence of a series: its UTC start, except for
 * all-day values, which match by calendar date. Used to apply EXDATE and
 * RECURRENCE-ID, which may be written in a different zone than DTSTART.
 */
export function occurrenceKey(value: IcalDateValue): number | null {
  const wall = toWall(value);
  if (!wall) return null;
  if (wall.kind === 'date') return wall.wallMs;
  return wallToUtc(wall).ms;
}

function occurrenceKeyForWall(wallMs: number, template: WallTime): number {
  if (template.kind === 'date') return wallMs;
  return wallToUtc({ ...template, wallMs }).ms;
}

// ─── RRULE ────────────────────────────────────────────────────────

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
/** RFC 5545 / RFC 7529 rule parts this expander refuses by name. */
const KNOWN_UNSUPPORTED_PARTS = new Set([
  'BYSECOND',
  'BYMINUTE',
  'BYHOUR',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYSETPOS',
  'RSCALE',
  'SKIP',
]);
const SUPPORTED_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'WKST',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
]);

interface ByDay {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** 1-based ordinal within the month (negative from the end), when given. */
  ordinal: number | null;
}

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  /** UNTIL as an occurrence key (UTC ms, or date ms for all-day). */
  until: number | null;
  wkst: number;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
}

type RuleParse = { ok: true; rule: Rule } | { ok: false; reason: string };

function parseIntStrict(raw: string): number | null {
  return /^[+-]?\d+$/.test(raw) ? Number(raw) : null;
}

/** Parse an RRULE value. Anything outside the supported subset is refused. */
export function parseRule(raw: string, dtstart: WallTime): RuleParse {
  const parts = new Map<string, string>();
  for (const segment of raw.split(';')) {
    if (!segment.trim()) continue;
    const eq = segment.indexOf('=');
    if (eq === -1) return { ok: false, reason: 'the rule is malformed' };
    parts.set(segment.slice(0, eq).trim().toUpperCase(), segment.slice(eq + 1).trim().toUpperCase());
  }
  for (const name of parts.keys()) {
    // Reasons reach tool output unenveloped, so they only ever name rule parts
    // from this fixed list — never text copied from the server.
    if (!SUPPORTED_PARTS.has(name)) {
      return {
        ok: false,
        reason: KNOWN_UNSUPPORTED_PARTS.has(name)
          ? `${name} is not supported`
          : 'the rule uses a part this connector does not recognise',
      };
    }
  }

  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    return {
      ok: false,
      reason:
        freq === 'SECONDLY' || freq === 'MINUTELY' || freq === 'HOURLY'
          ? `FREQ=${freq} is not supported`
          : 'the rule has no usable FREQ',
    };
  }

  const interval = parts.has('INTERVAL') ? parseIntStrict(parts.get('INTERVAL') ?? '') : 1;
  if (interval === null || interval < 1) return { ok: false, reason: 'INTERVAL must be 1 or more' };

  let count: number | null = null;
  if (parts.has('COUNT')) {
    count = parseIntStrict(parts.get('COUNT') ?? '');
    if (count === null || count < 1) return { ok: false, reason: 'COUNT must be 1 or more' };
  }

  let until: number | null = null;
  if (parts.has('UNTIL')) {
    const rawUntil = parts.get('UNTIL') ?? '';
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(rawUntil);
    if (!m) return { ok: false, reason: 'UNTIL is malformed' };
    if (m[4] === undefined) {
      // A date UNTIL includes that whole day.
      const day = Date.UTC(+m[1], +m[2] - 1, +m[3]);
      until =
        dtstart.kind === 'date'
          ? day
          : occurrenceKeyForWall(day + DAY_MS - 1000, dtstart);
    } else {
      const wallMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      until = m[7] ? wallMs : occurrenceKeyForWall(wallMs, dtstart);
    }
    if (Number.isNaN(until)) return { ok: false, reason: 'UNTIL is malformed' };
  }

  if (count !== null && until !== null) {
    return { ok: false, reason: 'COUNT and UNTIL together are not allowed' };
  }

  const wkstRaw = parts.get('WKST') ?? 'MO';
  const wkst = WEEKDAYS.indexOf(wkstRaw as (typeof WEEKDAYS)[number]);
  if (wkst === -1) return { ok: false, reason: 'WKST is not a weekday' };

  const byDay: ByDay[] = [];
  if (parts.has('BYDAY')) {
    for (const entry of (parts.get('BYDAY') ?? '').split(',')) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(entry.trim());
      if (!m) return { ok: false, reason: 'BYDAY is malformed' };
      const ordinal = m[1] === undefined ? null : Number(m[1]);
      if (ordinal !== null && (ordinal === 0 || Math.abs(ordinal) > 5)) {
        return { ok: false, reason: 'a BYDAY ordinal is out of range' };
      }
      byDay.push({ weekday: WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number]), ordinal });
    }
  }

  const intList = (name: string, min: number, max: number, allowNegative: boolean): number[] | null => {
    if (!parts.has(name)) return [];
    const values: number[] = [];
    for (const entry of (parts.get(name) ?? '').split(',')) {
      const value = parseIntStrict(entry.trim());
      if (value === null || value === 0) return null;
      if (value < 0 && !allowNegative) return null;
      if (Math.abs(value) < min || Math.abs(value) > max) return null;
      values.push(value);
    }
    return values;
  };
  const byMonthDay = intList('BYMONTHDAY', 1, 31, true);
  if (byMonthDay === null) return { ok: false, reason: 'BYMONTHDAY is malformed' };
  const byMonth = intList('BYMONTH', 1, 12, false);
  if (byMonth === null) return { ok: false, reason: 'BYMONTH is malformed' };

  const hasOrdinal = byDay.some((entry) => entry.ordinal !== null);
  if (hasOrdinal && (freq === 'DAILY' || freq === 'WEEKLY')) {
    return { ok: false, reason: `BYDAY ordinals are not valid with FREQ=${freq}` };
  }
  if (freq === 'YEARLY' && byDay.length > 0 && byMonth.length === 0) {
    return { ok: false, reason: 'YEARLY BYDAY without BYMONTH is not supported' };
  }
  if (freq === 'WEEKLY' && byMonthDay.length > 0) {
    return { ok: false, reason: 'BYMONTHDAY is not valid with FREQ=WEEKLY' };
  }

  return { ok: true, rule: { freq, interval, count, until, wkst, byDay, byMonthDay, byMonth } };
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Days (as day-start wall ms) in one month that match BYDAY / BYMONTHDAY. */
function daysInMonthMatching(
  year: number,
  monthIndex: number,
  rule: Rule,
  defaultDay: number,
): number[] {
  const length = daysInMonth(year, monthIndex);
  const dayMs = (day: number): number => Date.UTC(year, monthIndex, day);

  let days: number[];
  if (rule.byDay.length > 0) {
    const set = new Set<number>();
    for (const entry of rule.byDay) {
      const matching: number[] = [];
      for (let day = 1; day <= length; day += 1) {
        if (new Date(dayMs(day)).getUTCDay() === entry.weekday) matching.push(day);
      }
      if (entry.ordinal === null) matching.forEach((day) => set.add(day));
      else {
        const pick = entry.ordinal > 0 ? matching[entry.ordinal - 1] : matching[matching.length + entry.ordinal];
        if (pick !== undefined) set.add(pick);
      }
    }
    days = [...set];
    if (rule.byMonthDay.length > 0) {
      const allowed = new Set(rule.byMonthDay.map((md) => (md > 0 ? md : length + md + 1)));
      days = days.filter((day) => allowed.has(day));
    }
  } else if (rule.byMonthDay.length > 0) {
    days = rule.byMonthDay
      .map((md) => (md > 0 ? md : length + md + 1))
      .filter((day) => day >= 1 && day <= length);
  } else {
    // RFC 5545: a month without that day (the 31st in April) has no occurrence.
    days = defaultDay <= length ? [defaultDay] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b).map(dayMs);
}

/** All candidate day-starts (wall ms) of rule period `k`, unsorted ok. */
function periodDays(rule: Rule, k: number, start: Date): number[] {
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const monthOk = (dayMs: number): boolean =>
    rule.byMonth.length === 0 || rule.byMonth.includes(new Date(dayMs).getUTCMonth() + 1);

  switch (rule.freq) {
    case 'DAILY': {
      const day = startDay + k * rule.interval * DAY_MS;
      const date = new Date(day);
      if (!monthOk(day)) return [];
      if (rule.byDay.length > 0 && !rule.byDay.some((entry) => entry.weekday === date.getUTCDay())) {
        return [];
      }
      if (rule.byMonthDay.length > 0) {
        const length = daysInMonth(date.getUTCFullYear(), date.getUTCMonth());
        const allowed = rule.byMonthDay.map((md) => (md > 0 ? md : length + md + 1));
        if (!allowed.includes(date.getUTCDate())) return [];
      }
      return [day];
    }
    case 'WEEKLY': {
      const offset = (start.getUTCDay() - rule.wkst + 7) % 7;
      const weekStart = startDay - offset * DAY_MS + k * rule.interval * 7 * DAY_MS;
      const weekdays =
        rule.byDay.length > 0 ? rule.byDay.map((entry) => entry.weekday) : [start.getUTCDay()];
      const days: number[] = [];
      for (const weekday of new Set(weekdays)) {
        const day = weekStart + ((weekday - rule.wkst + 7) % 7) * DAY_MS;
        if (monthOk(day)) days.push(day);
      }
      return days;
    }
    case 'MONTHLY': {
      const monthIndex = start.getUTCMonth() + k * rule.interval;
      const year = start.getUTCFullYear() + Math.floor(monthIndex / 12);
      const month = ((monthIndex % 12) + 12) % 12;
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(month + 1)) return [];
      return daysInMonthMatching(year, month, rule, start.getUTCDate());
    }
    case 'YEARLY': {
      const year = start.getUTCFullYear() + k * rule.interval;
      const months = rule.byMonth.length > 0 ? rule.byMonth.map((m) => m - 1) : [start.getUTCMonth()];
      return months.flatMap((month) => daysInMonthMatching(year, month, rule, start.getUTCDate()));
    }
  }
}

/** Rule periods that fit between DTSTART and `wallMs` (for skipping ahead). */
function periodsBefore(rule: Rule, start: Date, wallMs: number): number {
  if (wallMs <= start.getTime()) return 0;
  const target = new Date(wallMs);
  switch (rule.freq) {
    case 'DAILY':
      return Math.floor((wallMs - start.getTime()) / (rule.interval * DAY_MS));
    case 'WEEKLY':
      return Math.floor((wallMs - start.getTime()) / (rule.interval * 7 * DAY_MS));
    case 'MONTHLY': {
      const months =
        (target.getUTCFullYear() - start.getUTCFullYear()) * 12 + target.getUTCMonth() - start.getUTCMonth();
      return Math.floor(months / rule.interval);
    }
    case 'YEARLY':
      return Math.floor((target.getUTCFullYear() - start.getUTCFullYear()) / rule.interval);
  }
}

// ─── Series expansion ─────────────────────────────────────────────

export interface Occurrence {
  start: IcalDateValue;
  end: IcalDateValue | null;
  /** UTC start (dates/floating read as UTC). */
  startUtc: number;
  endUtc: number | null;
  /** Identifies the occurrence for EXDATE / RECURRENCE-ID matching. */
  key: number;
}

export type SeriesExpansion =
  | { kind: 'expanded'; occurrences: Occurrence[]; timeZoneUnknown: boolean }
  | { kind: 'unsupported'; reason: string };

/**
 * Expand one recurring master into the occurrences overlapping
 * [rangeStartMs, rangeEndMs). EXDATEs are removed here; RECURRENCE-ID
 * overrides are applied by the caller (they live in sibling VEVENTs).
 */
export function expandSeries(
  event: IcalEvent,
  rangeStartMs: number,
  rangeEndMs: number,
): SeriesExpansion {
  const dtstart = toWall(event.start);
  if (!dtstart) return { kind: 'unsupported', reason: 'DTSTART could not be read' };
  const dtend = event.end ? toWall(event.end) : null;
  // Duration in the event's own clock; an end in a different zone/kind falls
  // back to the absolute difference.
  let durationMs = 0;
  if (dtend) {
    durationMs =
      dtend.kind === dtstart.kind && dtend.timeZone === dtstart.timeZone
        ? dtend.wallMs - dtstart.wallMs
        : wallToUtc(dtend).ms - wallToUtc(dtstart).ms;
  } else if (dtstart.kind === 'date') {
    durationMs = DAY_MS;
  }
  if (durationMs < 0) durationMs = 0;

  let rule: Rule | null = null;
  if (event.rrule) {
    const parsed = parseRule(event.rrule, dtstart);
    if (!parsed.ok) return { kind: 'unsupported', reason: parsed.reason };
    rule = parsed.rule;
  }

  const excluded = new Set<number>();
  for (const exdate of event.exdates) {
    const key = occurrenceKey(exdate);
    if (key !== null) excluded.add(key);
  }

  const start = new Date(dtstart.wallMs);
  const timeOfDay = dtstart.wallMs - Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  // Wall-clock window wide enough for any zone offset and the event's length.
  const windowStartWall = rangeStartMs - MAX_OFFSET_MS - durationMs;
  const windowEndWall = rangeEndMs + MAX_OFFSET_MS;

  let timeZoneUnknown = false;
  const occurrences = new Map<number, Occurrence>();
  const emit = (wallMs: number): void => {
    const startRes = wallToUtc({ ...dtstart, wallMs });
    timeZoneUnknown ||= startRes.timeZoneUnknown;
    const key = dtstart.kind === 'date' ? wallMs : startRes.ms;
    if (excluded.has(key) || occurrences.has(key)) return;
    const endWall = wallMs + durationMs;
    const endUtc = dtend || dtstart.kind === 'date' ? wallToUtc({ ...dtstart, wallMs: endWall }).ms : null;
    const effectiveEnd = endUtc ?? startRes.ms;
    const overlaps =
      effectiveEnd > startRes.ms
        ? startRes.ms < rangeEndMs && effectiveEnd > rangeStartMs
        : startRes.ms >= rangeStartMs && startRes.ms < rangeEndMs;
    if (!overlaps) return;
    occurrences.set(key, {
      start: fromWall(wallMs, dtstart),
      end: dtend || dtstart.kind === 'date' ? fromWall(endWall, dtend ?? dtstart) : null,
      startUtc: startRes.ms,
      endUtc,
      key,
    });
  };

  // DTSTART is always the first instance (RFC 5545 §3.8.5.3).
  emit(dtstart.wallMs);

  for (const rdate of event.rdates.slice(0, MAX_OCCURRENCES_PER_SERIES)) {
    const wall = toWall(rdate);
    if (!wall) continue;
    // An RDATE in another zone is mapped onto DTSTART's clock via UTC.
    const wallMs =
      wall.kind === dtstart.kind && wall.timeZone === dtstart.timeZone
        ? wall.wallMs
        : dtstart.kind === 'zoned' && dtstart.timeZone
          ? wallToUtc(wall).ms + (dtstart.wallMs - wallToUtc(dtstart).ms)
          : wallToUtc(wall).ms;
    emit(wallMs);
  }

  if (rule) {
    let generated = 1; // DTSTART
    let finished = false;
    // Without COUNT, nothing before the window matters: jump close to it.
    let k = rule.count === null ? Math.max(0, periodsBefore(rule, start, windowStartWall) - 1) : 0;
    let periods = 0;
    while (!finished && periods < MAX_PERIODS) {
      const days = periodDays(rule, k, start).sort((a, b) => a - b);
      for (const day of days) {
        const wallMs = day + timeOfDay;
        if (wallMs <= dtstart.wallMs) continue;
        if (wallMs > windowEndWall) {
          finished = true;
          break;
        }
        if (rule.until !== null && occurrenceKeyForWall(wallMs, dtstart) > rule.until) {
          finished = true;
          break;
        }
        if (rule.count !== null && generated >= rule.count) {
          finished = true;
          break;
        }
        generated += 1;
        emit(wallMs);
        if (occurrences.size >= MAX_OCCURRENCES_PER_SERIES) {
          finished = true;
          break;
        }
      }
      // A period whose first possible day is already past the window ends it
      // even when that period produced no candidate (e.g. BYMONTH filtered).
      if (!finished && periodStartAfter(rule, k + 1, start, windowEndWall)) finished = true;
      k += 1;
      periods += 1;
    }
    if (!finished) {
      return {
        kind: 'unsupported',
        reason: `the series needs more than ${MAX_PERIODS} steps to reach this range`,
      };
    }
  }

  return {
    kind: 'expanded',
    occurrences: [...occurrences.values()].sort((a, b) => a.startUtc - b.startUtc),
    timeZoneUnknown,
  };
}

/** True when period `k` cannot contain a day at or before `wallMs`. */
function periodStartAfter(rule: Rule, k: number, start: Date, wallMs: number): boolean {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = Date.UTC(y, m, start.getUTCDate());
  switch (rule.freq) {
    case 'DAILY':
      return d + k * rule.interval * DAY_MS > wallMs;
    case 'WEEKLY':
      // The week containing DTSTART may start up to 6 days earlier.
      return d + (k * rule.interval * 7 - 6) * DAY_MS > wallMs;
    case 'MONTHLY':
      return Date.UTC(y, m + k * rule.interval, 1) > wallMs;
    case 'YEARLY':
      return Date.UTC(y + k * rule.interval, 0, 1) > wallMs;
  }
}
