/**
 * HTTPS transport for CalDAV requests.
 *
 * The connector sends the user's mailbox password on every CalDAV request, so
 * this layer exists to make that safe and bounded:
 *
 *  - HTTPS only. A `http://` endpoint is refused outright rather than
 *    downgraded-with-a-warning: there is no way to send Basic credentials over
 *    cleartext safely, and a silent downgrade is the worst outcome.
 *  - Redirects are followed manually, at most 3 deep, and ONLY within the same
 *    origin (scheme + host + port). Credentials are never replayed to another
 *    origin. Alibaba's `/.well-known/caldav` redirect puts userinfo in the
 *    `Location` header, so userinfo is stripped from every redirect target.
 *  - Every request has a 20s timeout and every response body a 5 MB ceiling,
 *    so a slow or hostile endpoint produces a clear error instead of a hang or
 *    an unbounded buffer.
 *  - The password, the `Authorization` header, and response bodies never
 *    appear in an error message or a log line.
 */

import { EmailImapError } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { UNTRUSTED_CALENDAR_SOURCE } from './types.js';

export const CALDAV_TIMEOUT_MS = 20_000;
export const CALDAV_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const CALDAV_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface CalDavCredentials {
  email: string;
  password: string;
}

export interface CalDavRequest {
  method: 'PROPFIND' | 'REPORT' | 'OPTIONS';
  /** WebDAV `Depth` header. Omitted when undefined. */
  depth?: '0' | '1';
  /** XML request body; `Content-Type: application/xml` is added with it. */
  body?: string;
}

export interface CalDavResponse {
  status: number;
  /** Final URL the response came from (after any same-origin redirect). */
  url: URL;
  body: string;
  /**
   * Decoded body size in bytes. Surfaced because the per-response ceiling below
   * bounds ONE answer, while a multi-calendar query needs a running total (see
   * `MAX_TOTAL_RESPONSE_BYTES` in `client.ts`).
   */
  bytes: number;
}

/**
 * Validate a configured CalDAV URL: HTTPS, parseable, and with any userinfo
 * stripped (this layer supplies the Basic credentials itself — leaving
 * `https://user:pw@host/` in place would both duplicate them and leak the
 * password into every error message that names the URL).
 */
export function assertHttpsUrl(raw: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EmailImapError(
      `${field} is not a valid URL.`,
      'CALDAV_URL_INVALID',
      `Set ${field} to the full HTTPS URL of the calendar server, ` +
        'for example "https://caldav.example.com/principals/users/".',
    );
  }
  if (url.protocol !== 'https:') {
    throw new EmailImapError(
      `${field} must use https:// — the calendar password cannot be sent over an unencrypted connection.`,
      'CALDAV_URL_INSECURE',
      `Change ${field} to an https:// URL.`,
    );
  }
  url.username = '';
  url.password = '';
  return url;
}

/**
 * Resolve a `Location` header against the current URL and refuse anything that
 * would move the request (and therefore the credentials) to another origin.
 */
function resolveRedirectTarget(current: URL, location: string): URL {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new EmailImapError(
      `The calendar server at ${current.host} answered with a redirect this connector could not resolve.`,
      'CALDAV_BAD_REDIRECT',
      'Check EMAIL_IMAP_CALDAV_URL, or ask the mail provider for the exact CalDAV endpoint.',
    );
  }
  // Some servers (Alibaba's .well-known handler among them) put credentials in
  // the Location URL. Drop them: this layer owns authentication.
  next.username = '';
  next.password = '';
  if (next.protocol !== 'https:' || next.origin !== current.origin) {
    throw new EmailImapError(
      `The calendar server at ${current.host} redirected to a different host (${next.host}). ` +
        'The connector refused to follow it, because that would send the calendar password to another server.',
      'CALDAV_CROSS_ORIGIN_REDIRECT',
      `Set EMAIL_IMAP_CALDAV_URL to the server you actually want to talk to (${next.protocol}//${next.host}) ` +
        'if that redirect is expected.',
    );
  }
  return next;
}

/**
 * Read a response body with a hard byte ceiling, cancelling the stream as soon
 * as the ceiling is crossed so a hostile endpoint cannot stream unbounded data
 * into memory.
 */
async function readBodyCapped(
  response: Response,
  host: string,
): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CALDAV_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw oversizedBody(host);
  }

  if (!response.body) return { text: '', bytes: 0 };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > CALDAV_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw oversizedBody(host);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(joined), bytes: total };
}

function oversizedBody(host: string): EmailImapError {
  return new EmailImapError(
    `The calendar server at ${host} sent more than ${Math.round(
      CALDAV_MAX_RESPONSE_BYTES / (1024 * 1024),
    )} MB in one response, so the connector stopped reading it.`,
    'CALDAV_RESPONSE_TOO_LARGE',
    'Ask for a shorter date range (a narrower start/end), or for one calendar at a time.',
  );
}

function basicAuthHeader(credentials: CalDavCredentials): string {
  const raw = `${credentials.email}:${credentials.password}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * Perform one CalDAV request, following same-origin redirects. Returns the
 * response for ANY non-redirect status — status interpretation belongs to the
 * caller, because a 403 means different things for an auth failure and for an
 * unsupported report element.
 */
export async function caldavRequest(
  url: URL,
  request: CalDavRequest,
  credentials: CalDavCredentials,
): Promise<CalDavResponse> {
  let current = url;

  for (let redirects = 0; ; redirects += 1) {
    const headers: Record<string, string> = {
      Authorization: basicAuthHeader(credentials),
      Accept: 'application/xml, text/xml',
    };
    if (request.depth !== undefined) headers.Depth = request.depth;
    if (request.body !== undefined) headers['Content-Type'] = 'application/xml; charset=utf-8';

    let response: Response;
    try {
      response = await fetch(current, {
        method: request.method,
        headers,
        body: request.body,
        // Manual, so a redirect can be inspected before the credentials are
        // replayed to the target.
        redirect: 'manual',
        signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
      });
    } catch (error) {
      throw transportError(current, error);
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      let body: { text: string; bytes: number };
      try {
        body = await readBodyCapped(response, current.host);
      } catch (error) {
        // The request's timeout also governs the body stream; a timeout that
        // fires mid-read gets the same friendly error as one before headers.
        if (error instanceof EmailImapError) throw error;
        throw transportError(current, error);
      }
      return { status: response.status, url: current, body: body.text, bytes: body.bytes };
    }

    await response.body?.cancel().catch(() => undefined);

    if (redirects >= CALDAV_MAX_REDIRECTS) {
      throw new EmailImapError(
        `The calendar server at ${current.host} kept redirecting (more than ${CALDAV_MAX_REDIRECTS} times).`,
        'CALDAV_TOO_MANY_REDIRECTS',
        'Set EMAIL_IMAP_CALDAV_URL to the final CalDAV endpoint instead of a redirecting one.',
      );
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new EmailImapError(
        `The calendar server at ${current.host} answered ${response.status} with no Location header.`,
        'CALDAV_BAD_REDIRECT',
        'Check EMAIL_IMAP_CALDAV_URL, or ask the mail provider for the exact CalDAV endpoint.',
      );
    }

    // Method and body are preserved across the redirect: a WebDAV PROPFIND or
    // REPORT that silently became a GET would answer a different question.
    current = resolveRedirectTarget(current, location);
  }
}

function transportError(url: URL, error: unknown): EmailImapError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new EmailImapError(
      `The calendar server at ${url.host} did not answer within ${CALDAV_TIMEOUT_MS / 1000} seconds.`,
      'CALDAV_TIMEOUT',
      'Try again, or ask for a shorter date range. If it keeps timing out, check the calendar server address.',
    );
  }
  // The underlying message is runtime/network text (DNS, TLS) — enveloped
  // rather than inlined raw, because EmailImapError messages are returned to
  // the model as-is.
  const detail = error instanceof Error ? error.message : String(error);
  return new EmailImapError(
    `Could not reach the calendar server at ${url.host}. Underlying error: ` +
      `${wrapUntrusted(detail, UNTRUSTED_CALENDAR_SOURCE)}`,
    'CALDAV_UNREACHABLE',
    'Check EMAIL_IMAP_CALDAV_URL and that this machine can reach that host over HTTPS.',
  );
}

/**
 * The 401/403 mapping. Alibaba (and most providers) answer 401 for a wrong
 * password AND for an account that belongs to a different regional host, so
 * the message names both causes.
 */
export function authError(status: number, host: string): EmailImapError {
  return new EmailImapError(
    `The calendar server at ${host} rejected the login (HTTP ${status}).`,
    'CALDAV_AUTH_FAILED',
    'Check the email address and password used for mail — the calendar uses the same ones. ' +
      'If the password is right, the account may belong to a different regional calendar server, ' +
      'so check EMAIL_IMAP_CALDAV_URL too.',
  );
}

/**
 * Require a WebDAV multistatus (207) — or a plain 200, which a few servers
 * answer PROPFIND with. Any other status becomes a structured error that
 * carries the status only: a response BODY is attacker-influenceable text and
 * EmailImapError messages reach the model unenveloped.
 */
export function assertMultiStatus(response: CalDavResponse, operation: string): void {
  if (response.status === 207 || response.status === 200) return;
  if (response.status === 401 || response.status === 403) {
    throw authError(response.status, response.url.host);
  }
  throw new EmailImapError(
    `The calendar server at ${response.url.host} answered HTTP ${response.status} for ${operation}.`,
    'CALDAV_REQUEST_FAILED',
    'Confirm EMAIL_IMAP_CALDAV_URL points at the provider\'s CalDAV endpoint, then try again.',
  );
}
