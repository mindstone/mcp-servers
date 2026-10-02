/**
 * Shared CalDAV types and the untrusted-content source tag for calendar data.
 */

/**
 * Envelope source tag for every string a calendar server hands back.
 *
 * Calendar text is at least as attacker-controlled as email text: a meeting
 * invite's summary, description, location and attendee list are authored by
 * whoever sent the invite, and they land in the user's calendar without the
 * user ever opening a message. Everything server-authored therefore goes out
 * inside an `<untrusted-content source="external-calendar">` envelope, exactly
 * as email subjects and bodies do (AGENTS.md security invariant #6).
 */
export const UNTRUSTED_CALENDAR_SOURCE = 'external-calendar';

/** One calendar collection discovered under the account's calendar home. */
export interface CalDavCalendar {
  /** Server path/URL of the collection. Doubles as the stable id. */
  href: string;
  /** `displayname`, when the server provides one. */
  displayName: string | null;
  /** `calendar-description`, when the server provides one. */
  description: string | null;
}

/** One `calendar-query` result row: the raw iCalendar object plus its etag. */
export interface CalDavEventResource {
  /** Href of the event resource, when the server reported one. */
  href: string | null;
  etag: string | null;
  /** Raw VCALENDAR text as returned in `calendar-data`. */
  ical: string;
}
