import { describe, expect, it } from 'vitest';
import { parseVEvents } from '../src/caldav/ical.js';
import { instancesInRange } from '../src/caldav/occurrences.js';
import { expandSeries, parseRule, toWall, zonedWallTimeToUtc } from '../src/caldav/recurrence.js';

const ms = (iso: string): number => new Date(iso).getTime();

function vcal(...vevents: string[][]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//Recurrence//EN',
    ...vevents.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');
}

function instances(ics: string, start: string, end: string) {
  return instancesInRange(parseVEvents(ics).events, ms(start), ms(end));
}

function startsUtc(ics: string, start: string, end: string): string[] {
  return instances(ics, start, end).instances.map((i) => new Date(i.startUtc).toISOString());
}

// The live-captured shape: Alibaba returns this master for every range.
const WEEKLY_HK = vcal([
  'UID:weekly-hk',
  'DTSTART;TZID=Asia/Hong_Kong:20261006T100000',
  'DTEND;TZID=Asia/Hong_Kong:20261006T103000',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'SUMMARY:Weekly sync',
]);

describe('zonedWallTimeToUtc', () => {
  it('converts a fixed-offset zone', () => {
    expect(zonedWallTimeToUtc(Date.UTC(2026, 9, 6, 10, 0, 0), 'Asia/Hong_Kong')).toBe(
      ms('2026-10-06T02:00:00Z'),
    );
  });

  it('follows DST in Europe/London', () => {
    expect(zonedWallTimeToUtc(Date.UTC(2026, 9, 20, 9, 0, 0), 'Europe/London')).toBe(
      ms('2026-10-20T08:00:00Z'),
    );
    expect(zonedWallTimeToUtc(Date.UTC(2026, 9, 27, 9, 0, 0), 'Europe/London')).toBe(
      ms('2026-10-27T09:00:00Z'),
    );
  });

  it('picks the earlier instant in an overlap and shifts forward in a gap', () => {
    // 01:30 on 25 Oct 2026 happens twice in London (BST then GMT).
    expect(zonedWallTimeToUtc(Date.UTC(2026, 9, 25, 1, 30, 0), 'Europe/London')).toBe(
      ms('2026-10-25T00:30:00Z'),
    );
    // 01:30 on 29 Mar 2026 never happens in London.
    expect(zonedWallTimeToUtc(Date.UTC(2026, 2, 29, 1, 30, 0), 'Europe/London')).toBe(
      ms('2026-03-29T01:30:00Z'),
    );
  });

  it('throws RangeError for an unknown zone', () => {
    expect(() => zonedWallTimeToUtc(Date.UTC(2026, 0, 1), 'Mars/Olympus_Mons')).toThrow(RangeError);
  });
});

describe('weekly series as Alibaba returns it (master only)', () => {
  it('expands all four occurrences at 10:00 Hong Kong time', () => {
    expect(startsUtc(WEEKLY_HK, '2026-10-05T00:00:00Z', '2026-11-05T00:00:00Z')).toEqual([
      '2026-10-06T02:00:00.000Z',
      '2026-10-13T02:00:00.000Z',
      '2026-10-20T02:00:00.000Z',
      '2026-10-27T02:00:00.000Z',
    ]);
    const first = instances(WEEKLY_HK, '2026-10-12T00:00:00Z', '2026-10-15T00:00:00Z').instances[0];
    expect(first.event.start).toEqual({ dateTime: '2026-10-13T10:00:00', timeZone: 'Asia/Hong_Kong' });
    expect(first.event.end).toEqual({ dateTime: '2026-10-13T10:30:00', timeZone: 'Asia/Hong_Kong' });
  });

  it('returns only the occurrence inside a narrow range', () => {
    expect(startsUtc(WEEKLY_HK, '2026-10-12T00:00:00Z', '2026-10-15T00:00:00Z')).toEqual([
      '2026-10-13T02:00:00.000Z',
    ]);
  });

  it('returns nothing for a range after the series ended', () => {
    const result = instances(WEEKLY_HK, '2026-12-01T00:00:00Z', '2026-12-05T00:00:00Z');
    expect(result.instances).toEqual([]);
    expect(result.seriesNotExpanded).toBe(0);
  });
});

describe('rule coverage', () => {
  it('BYDAY=MO,WE,FR weekly', () => {
    const ics = vcal([
      'UID:mwf',
      'DTSTART:20261005T080000Z',
      'DTEND:20261005T081500Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
    ]);
    expect(startsUtc(ics, '2026-10-05T00:00:00Z', '2026-10-12T00:00:00Z')).toEqual([
      '2026-10-05T08:00:00.000Z',
      '2026-10-07T08:00:00.000Z',
      '2026-10-09T08:00:00.000Z',
    ]);
  });

  it('every other week with INTERVAL=2', () => {
    const ics = vcal(['UID:biweekly', 'DTSTART:20261001T090000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2']);
    expect(startsUtc(ics, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')).toEqual([
      '2026-10-01T09:00:00.000Z',
      '2026-10-15T09:00:00.000Z',
      '2026-10-29T09:00:00.000Z',
    ]);
  });

  it('monthly on the last Friday', () => {
    const ics = vcal(['UID:lastfri', 'DTSTART:20260925T150000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR']);
    expect(startsUtc(ics, '2026-10-01T00:00:00Z', '2027-01-01T00:00:00Z')).toEqual([
      '2026-10-30T15:00:00.000Z',
      '2026-11-27T15:00:00.000Z',
      '2026-12-25T15:00:00.000Z',
    ]);
  });

  it('monthly on the 31st skips short months', () => {
    const ics = vcal(['UID:31st', 'DTSTART:20260831T120000Z', 'RRULE:FREQ=MONTHLY']);
    expect(startsUtc(ics, '2026-09-01T00:00:00Z', '2027-01-01T00:00:00Z')).toEqual([
      '2026-10-31T12:00:00.000Z',
      '2026-12-31T12:00:00.000Z',
    ]);
  });

  it('yearly all-day birthday, with a series that started years ago', () => {
    const ics = vcal([
      'UID:bday',
      'DTSTART;VALUE=DATE:19900314',
      'DTEND;VALUE=DATE:19900315',
      'RRULE:FREQ=YEARLY',
    ]);
    const result = instances(ics, '2027-03-01T00:00:00Z', '2027-04-01T00:00:00Z');
    expect(result.instances.map((i) => i.event.start)).toEqual([{ date: '2027-03-14' }]);
    expect(result.instances[0].event.end).toEqual({ date: '2027-03-15' });
  });

  it('a daily standup that began years ago still reaches the range (skip-ahead)', () => {
    const ics = vcal(['UID:standup', 'DTSTART:20190107T013000Z', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR']);
    expect(startsUtc(ics, '2026-10-05T00:00:00Z', '2026-10-08T00:00:00Z')).toEqual([
      '2026-10-05T01:30:00.000Z',
      '2026-10-06T01:30:00.000Z',
      '2026-10-07T01:30:00.000Z',
    ]);
  });

  it('UNTIL is inclusive', () => {
    const ics = vcal(['UID:until', 'DTSTART:20261001T090000Z', 'RRULE:FREQ=DAILY;UNTIL=20261003T090000Z']);
    expect(startsUtc(ics, '2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z')).toEqual([
      '2026-10-01T09:00:00.000Z',
      '2026-10-02T09:00:00.000Z',
      '2026-10-03T09:00:00.000Z',
    ]);
  });

  it('EXDATE removes an occurrence, even when written in UTC for a zoned series', () => {
    const ics = vcal([
      'UID:exdate',
      'DTSTART;TZID=Asia/Hong_Kong:20261006T100000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'EXDATE:20261013T020000Z',
    ]);
    expect(startsUtc(ics, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')).toEqual([
      '2026-10-06T02:00:00.000Z',
      '2026-10-20T02:00:00.000Z',
    ]);
  });

  it('a moved RECURRENCE-ID override replaces its occurrence; a cancelled one removes it', () => {
    const ics = vcal(
      [
        'UID:series',
        'DTSTART;TZID=Asia/Hong_Kong:20261006T100000',
        'DTEND;TZID=Asia/Hong_Kong:20261006T103000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:Sync',
      ],
      [
        'UID:series',
        'RECURRENCE-ID;TZID=Asia/Hong_Kong:20261013T100000',
        'DTSTART;TZID=Asia/Hong_Kong:20261014T150000',
        'DTEND;TZID=Asia/Hong_Kong:20261014T153000',
        'SUMMARY:Sync (moved)',
      ],
      [
        'UID:series',
        'RECURRENCE-ID;TZID=Asia/Hong_Kong:20261020T100000',
        'DTSTART;TZID=Asia/Hong_Kong:20261020T100000',
        'STATUS:CANCELLED',
      ],
    );
    const result = instances(ics, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(result.instances.map((i) => [i.event.summary, new Date(i.startUtc).toISOString()])).toEqual([
      ['Sync', '2026-10-06T02:00:00.000Z'],
      ['Sync (moved)', '2026-10-14T07:00:00.000Z'],
    ]);
  });

  it('keeps local time across a DST change (Europe/London)', () => {
    const ics = vcal(['UID:dst', 'DTSTART;TZID=Europe/London:20261019T090000', 'RRULE:FREQ=WEEKLY']);
    expect(startsUtc(ics, '2026-10-18T00:00:00Z', '2026-11-03T00:00:00Z')).toEqual([
      '2026-10-19T08:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
    ]);
  });

  it('includes RDATE extras', () => {
    const ics = vcal([
      'UID:rdate',
      'DTSTART:20261001T090000Z',
      'RRULE:FREQ=WEEKLY;COUNT=1',
      'RDATE:20261010T090000Z,20261020T090000Z',
    ]);
    expect(startsUtc(ics, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')).toEqual([
      '2026-10-01T09:00:00.000Z',
      '2026-10-10T09:00:00.000Z',
      '2026-10-20T09:00:00.000Z',
    ]);
  });
});

describe('degradation is visible, never guessed', () => {
  it('flags an unsupported rule part and reports the master once', () => {
    const ics = vcal([
      'UID:setpos',
      'DTSTART:20261001T090000Z',
      'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
    ]);
    const result = instances(ics, '2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z');
    expect(result.seriesNotExpanded).toBe(1);
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0].recurrenceUnexpanded).toBe(true);
    expect(result.instances[0].recurrenceUnexpandedReason).toMatch(/BYSETPOS/);
  });

  it('does not report an unsupported series that starts after the range', () => {
    const ics = vcal(['UID:later', 'DTSTART:20270101T090000Z', 'RRULE:FREQ=HOURLY']);
    expect(instances(ics, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z').instances).toEqual([]);
  });

  it.each([
    'FREQ=WEEKLY;INTERVAL=0',
    'FREQ=DAILY;COUNT=0',
    'FREQ=DAILY;UNTIL=garbage',
    'FREQ=MINUTELY',
    'FREQ=WEEKLY;BYDAY=XX',
    'FREQ=DAILY;COUNT=3;UNTIL=20261231T000000Z',
    'nonsense',
  ])('refuses %s', (rule) => {
    const wall = toWall({ dateTime: '2026-10-01T09:00:00Z' });
    expect(wall).not.toBeNull();
    expect(parseRule(rule, wall!).ok).toBe(false);
  });

  it('terminates on a rule whose BYMONTH never matches', () => {
    const ics = vcal(['UID:never', 'DTSTART:20261001T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30']);
    const result = instances(ics, '2026-10-01T00:00:00Z', '2027-10-01T00:00:00Z');
    // DTSTART itself is always an instance (RFC 5545); nothing else exists.
    expect(result.instances.map((i) => new Date(i.startUtc).toISOString())).toEqual([
      '2026-10-01T09:00:00.000Z',
    ]);
  });

  it('reads an unknown TZID as UTC and counts it', () => {
    const ics = vcal(['UID:mars', 'DTSTART;TZID=Mars/Olympus_Mons:20261006T100000', 'RRULE:FREQ=DAILY;COUNT=2']);
    const result = instances(ics, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(result.timeZoneUnknown).toBe(1);
    expect(result.instances.map((i) => new Date(i.startUtc).toISOString())).toEqual([
      '2026-10-06T10:00:00.000Z',
      '2026-10-07T10:00:00.000Z',
    ]);
  });

  it('expandSeries stops at its step budget instead of looping', () => {
    const event = parseVEvents(
      vcal(['UID:far', 'DTSTART:20000101T000000Z', 'RRULE:FREQ=DAILY;COUNT=100000']),
    ).events[0];
    const result = expandSeries(event, ms('2026-10-01T00:00:00Z'), ms('2026-10-02T00:00:00Z'));
    expect(result.kind).toBe('unsupported');
  });
});

describe('server-expanded instances pass through', () => {
  it('keeps instances that carry RECURRENCE-ID and no RRULE', () => {
    const ics = vcal(
      ['UID:s', 'RECURRENCE-ID:20261006T020000Z', 'DTSTART:20261006T020000Z', 'SUMMARY:A'],
      ['UID:s', 'RECURRENCE-ID:20261013T020000Z', 'DTSTART:20261013T020000Z', 'SUMMARY:A'],
    );
    const result = instances(ics, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(result.instances).toHaveLength(2);
    expect(result.seriesNotExpanded).toBe(0);
  });
});
