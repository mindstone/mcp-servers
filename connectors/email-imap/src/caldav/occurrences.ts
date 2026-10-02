/**
 * Turn the VEVENTs of one CalDAV resource into the event instances that fall
 * in a time range.
 *
 * A resource holds one event, or a recurring series: a master (RRULE/RDATE)
 * plus override instances that share its UID and carry a RECURRENCE-ID. A
 * server that honoured `CALDAV:expand` sends already-expanded instances (no
 * RRULE, each with a RECURRENCE-ID); one that did not (Alibaba Mail) sends the
 * master, and `recurrence.ts` expands it here.
 */

import type { IcalEvent } from './ical.js';
import { expandSeries, occurrenceKey, toWall, wallToUtc } from './recurrence.js';

export interface EventInstance {
  /** The event, with `start`/`end` set to this instance's times. */
  event: IcalEvent;
  /** UTC start in ms (all-day and floating times read as UTC). */
  startUtc: number;
  endUtc: number | null;
  /** The series could not be expanded; this is the master, reported once. */
  recurrenceUnexpanded: boolean;
  /** Why it could not be expanded (connector-generated text). */
  recurrenceUnexpandedReason?: string;
}

export interface ResourceInstances {
  instances: EventInstance[];
  /** Series reported unexpanded (see `recurrenceUnexpanded`). */
  seriesNotExpanded: number;
  /** Events whose TZID this runtime does not know; their times were read as UTC. */
  timeZoneUnknown: number;
}

function utcOf(event: IcalEvent): { start: number; end: number | null; unknownZone: boolean } {
  const startWall = toWall(event.start);
  const endWall = event.end ? toWall(event.end) : null;
  const start = startWall ? wallToUtc(startWall) : { ms: event.sortKey, timeZoneUnknown: false };
  const end = endWall ? wallToUtc(endWall) : null;
  return {
    start: start.ms,
    end: end ? end.ms : null,
    unknownZone: start.timeZoneUnknown || (end?.timeZoneUnknown ?? false),
  };
}

function overlaps(start: number, end: number | null, rangeStart: number, rangeEnd: number): boolean {
  if (end !== null && end > start) return start < rangeEnd && end > rangeStart;
  return start >= rangeStart && start < rangeEnd;
}

function isSeriesMaster(event: IcalEvent): boolean {
  return event.recurrenceId === null && (event.rrule !== null || event.rdates.length > 0);
}

/**
 * Instances of every VEVENT in one resource that overlap [rangeStart, rangeEnd).
 *
 * Non-recurring events are kept as the server returned them (the server owns
 * the time-range match for those); recurring masters are expanded and filtered
 * here, because a server that skips expansion also tends to return masters for
 * series that never touch the range.
 */
export function instancesInRange(
  events: IcalEvent[],
  rangeStart: number,
  rangeEnd: number,
): ResourceInstances {
  const instances: EventInstance[] = [];
  let seriesNotExpanded = 0;
  let timeZoneUnknown = 0;

  // RECURRENCE-ID overrides, by series UID → occurrence keys they replace.
  const overridden = new Map<string, Set<number>>();
  for (const event of events) {
    if (event.recurrenceId === null) continue;
    const key = occurrenceKey(event.recurrenceId);
    if (key === null) continue;
    const uid = event.uid ?? '';
    const keys = overridden.get(uid) ?? new Set<number>();
    keys.add(key);
    overridden.set(uid, keys);
  }

  for (const event of events) {
    if (isSeriesMaster(event)) {
      const expansion = expandSeries(event, rangeStart, rangeEnd);
      if (expansion.kind === 'unsupported') {
        // Not guessed at: the master is reported once, flagged, when the
        // series could still touch the range (it starts before the range ends).
        const times = utcOf(event);
        if (times.unknownZone) timeZoneUnknown += 1;
        if (times.start < rangeEnd) {
          seriesNotExpanded += 1;
          instances.push({
            event,
            startUtc: times.start,
            endUtc: times.end,
            recurrenceUnexpanded: true,
            recurrenceUnexpandedReason: expansion.reason,
          });
        }
        continue;
      }
      if (expansion.timeZoneUnknown) timeZoneUnknown += 1;
      const replaced = overridden.get(event.uid ?? '') ?? new Set<number>();
      for (const occurrence of expansion.occurrences) {
        if (replaced.has(occurrence.key)) continue;
        instances.push({
          event: { ...event, start: occurrence.start, end: occurrence.end, sortKey: occurrence.startUtc },
          startUtc: occurrence.startUtc,
          endUtc: occurrence.endUtc,
          recurrenceUnexpanded: false,
        });
      }
      continue;
    }

    // A cancelled override removes its occurrence and shows nothing.
    if (event.recurrenceId !== null && event.status?.toUpperCase() === 'CANCELLED') continue;

    const times = utcOf(event);
    if (times.unknownZone) timeZoneUnknown += 1;
    // Overrides (and server-expanded instances) can be moved anywhere, so they
    // are range-checked; plain events trust the server's own match.
    if (event.recurrenceId !== null && !overlaps(times.start, times.end, rangeStart, rangeEnd)) continue;
    instances.push({
      event: { ...event, sortKey: times.start },
      startUtc: times.start,
      endUtc: times.end,
      recurrenceUnexpanded: false,
    });
  }

  return { instances, seriesNotExpanded, timeZoneUnknown };
}
