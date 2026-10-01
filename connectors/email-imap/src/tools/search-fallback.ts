/**
 * Local-filter fallback for IMAP servers that reject the text SEARCH keys.
 *
 * Some servers implement `SEARCH ALL` / `SINCE` / `UNSEEN` but answer
 * `SEARCH FROM` or `SEARCH SUBJECT` with `BAD invalid command or parameters`
 * (Alibaba Mail is one, with or without a CHARSET prefix). imapflow reports
 * that by RETURNING `false` from `search()` rather than by throwing, so
 * mapping a non-array result to an empty UID list turned the server's "I
 * cannot search that way" into the connector's "no messages" — a silent
 * failure the model cannot tell apart from a genuinely empty mailbox.
 *
 * Instead the search is re-run with only the keys such a server does support
 * (a date window, plus `before`/unread when the caller asked for them) and the
 * candidates' envelopes are filtered here. The response keeps the same shape
 * and cursor contract, and says it was filtered locally and over which window,
 * so the model can widen `since` or page with `before_uid`.
 */

import type { FetchMessageObject, ImapFlow, MessageAddressObject, SearchObject } from 'imapflow';

import { EmailImapError } from '../types.js';
import { formatAddresses, formatDate } from './shared.js';

/**
 * Window the candidate search covers when the caller gave no `since`. A
 * date-bounded search is the whole point of the fallback: without a bound the
 * candidate set is the entire mailbox, and every page would fetch envelopes
 * until the scan cap regardless of how recent the matches are.
 */
export const FALLBACK_DEFAULT_WINDOW_DAYS = 90;

/**
 * Most candidate envelopes examined for a single page. Caps the work a search
 * over a busy window can do; the page then reports `hasMore` with a cursor, so
 * the scan is resumable rather than truncated.
 */
export const FALLBACK_MAX_SCANNED = 1000;

/** UIDs per FETCH round-trip while scanning candidates. */
const FETCH_BATCH_SIZE = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface LocalFilterRequest {
  /** Sender substring to match locally; `undefined` when not filtering. */
  from?: string;
  /** Subject substring to match locally; `undefined` when not filtering. */
  subject?: string;
  unread: boolean;
  since?: Date;
  before?: Date;
  beforeUid?: number;
  limit: number;
}

/**
 * One matched message. Envelope text is RAW here — filtering runs on the
 * server's values, and the caller applies the untrusted-content envelopes on
 * the way into the response.
 */
export interface LocalFilterMessage {
  uid: number;
  subject: string;
  from: string;
  date: string | null;
  flags: string[];
}

export interface LocalFilterResult {
  messages: LocalFilterMessage[];
  hasMore: boolean;
  /** Cursor for the next (older) page. Present only when `hasMore`. */
  nextBeforeUid?: number;
  /** Start of the window the candidate search covered. */
  searchedSince: Date;
  /** Candidate envelopes examined for this page. */
  scannedCount: number;
  /** True when FALLBACK_MAX_SCANNED, not the candidate list, ended the scan. */
  scanCapHit: boolean;
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Mirror IMAP `SEARCH FROM` substring semantics: the server matches against
 * the raw From header, which carries both the display name and the address, so
 * test the rendered `Name <address>` form — a superset of both — plus the bare
 * name, which has no rendered form of its own when the address is missing.
 */
function fromMatches(
  addresses: MessageAddressObject[] | undefined,
  needle: string,
): boolean {
  return (addresses ?? []).some(
    (address) =>
      containsIgnoreCase(formatAddresses([address]), needle) ||
      containsIgnoreCase(address.name ?? '', needle),
  );
}

/**
 * Run a date-bounded candidate search the server can answer, then filter the
 * candidates' envelopes locally on `from`/`subject`.
 *
 * Throws (never returns an empty page) when the candidate search is rejected
 * too: at that point nothing has been searched, and reporting that as "no
 * messages" is the very failure this fallback exists to remove.
 */
export async function searchByLocalFilter(
  client: ImapFlow,
  request: LocalFilterRequest,
): Promise<LocalFilterResult> {
  // The default window ends where the caller's own search does. Anchoring it
  // to `now` instead would, for a `before` older than the window, start the
  // window AFTER it ends — an inverted range that matches nothing however much
  // mail sits in it, which is the silent empty this fallback exists to remove.
  const windowEnd = request.before ?? new Date();
  const searchedSince =
    request.since ??
    new Date(windowEnd.getTime() - FALLBACK_DEFAULT_WINDOW_DAYS * MS_PER_DAY);

  const criteria: SearchObject = { all: true, since: searchedSince };
  if (request.before) {
    criteria.before = request.before;
  }
  if (request.unread) {
    criteria.seen = false;
  }

  const candidateResult = await client.search(criteria, { uid: true });
  if (!Array.isArray(candidateResult)) {
    throw new EmailImapError(
      'The mail server rejected the search by sender/subject AND the date-bounded ' +
        'search this connector falls back to, so nothing was searched. This is not ' +
        'an empty mailbox.',
      'SEARCH_FALLBACK_REJECTED',
      'Confirm the mailbox name with email_get_mailbox_status, then retry with no ' +
        'filters at all.',
    );
  }

  const candidates = candidateResult
    .filter((uid) => request.beforeUid === undefined || uid < request.beforeUid)
    .sort((a, b) => b - a);
  const scanLimit = Math.min(candidates.length, FALLBACK_MAX_SCANNED);

  const messages: LocalFilterMessage[] = [];
  let scanned = 0;
  let lastScannedUid: number | undefined;

  while (scanned < scanLimit && messages.length < request.limit) {
    const batch = candidates.slice(
      scanned,
      Math.min(scanned + FETCH_BATCH_SIZE, scanLimit),
    );

    // FETCH answers in the server's own order, so index the batch by UID and
    // walk it newest-first here instead: scanning in UID-descending order is
    // what makes the `nextBeforeUid` cursor below gap-free.
    const fetched = new Map<number, FetchMessageObject>();
    for await (const message of client.fetch(
      batch,
      { uid: true, envelope: true, flags: true },
      { uid: true },
    )) {
      fetched.set(message.uid, message);
    }

    for (const uid of batch) {
      scanned += 1;
      lastScannedUid = uid;

      const message = fetched.get(uid);
      if (!message) {
        // Expunged between the SEARCH and the FETCH.
        continue;
      }

      const subject = message.envelope?.subject ?? '';
      const fromAddresses = message.envelope?.from;
      if (request.subject !== undefined && !containsIgnoreCase(subject, request.subject)) {
        continue;
      }
      if (request.from !== undefined && !fromMatches(fromAddresses, request.from)) {
        continue;
      }

      messages.push({
        uid,
        subject,
        from: formatAddresses(fromAddresses),
        date: formatDate(message.envelope?.date),
        flags: message.flags ? [...message.flags] : [],
      });

      if (messages.length >= request.limit) {
        break;
      }
    }
  }

  const hasMore = scanned < candidates.length;

  return {
    messages,
    hasMore,
    // The scan stops on the match that fills the page, so the last UID scanned
    // IS the last UID returned; when the scan cap stops it first, it is the
    // lowest UID scanned. Either way the next page resumes strictly below it,
    // so no candidate is returned twice and none is skipped.
    ...(hasMore && lastScannedUid !== undefined ? { nextBeforeUid: lastScannedUid } : {}),
    searchedSince,
    scannedCount: scanned,
    // The cap stopped the scan when it is what the scan ran into AND it was
    // below the candidate count. Derived from the scan itself rather than from
    // the page being short, so a page that fills exactly on the cap's last
    // candidate still reports the cap.
    scanCapHit: scanned >= scanLimit && scanLimit < candidates.length,
  };
}

/**
 * Plain-English, model-facing explanation of what the fallback actually did:
 * which window was listed, how much of it was checked, and which argument to
 * change to see more. Deliberately carries no caller-supplied search text —
 * this field is connector-authored and is NOT returned inside an
 * untrusted-content envelope.
 */
export function describeLocalFilter(result: LocalFilterResult): string {
  const windowStart = result.searchedSince.toISOString().slice(0, 10);
  const preamble =
    'This mail server cannot search by sender or subject, so the connector listed the ' +
    `messages since ${windowStart} and filtered them here.`;

  if (result.scanCapHit) {
    return (
      `${preamble} Only the ${result.scannedCount} newest of them were checked for this ` +
      'page — pass `before_uid` set to `nextBeforeUid` to keep going through older ' +
      'messages, or an earlier `since` date to widen the window.'
    );
  }

  if (result.hasMore) {
    return (
      `${preamble} Pass \`before_uid\` set to \`nextBeforeUid\` for older results, or an ` +
      'earlier `since` date to widen the window.'
    );
  }

  return (
    `${preamble} Everything in that window was checked; pass an earlier \`since\` date ` +
    'to look further back.'
  );
}
