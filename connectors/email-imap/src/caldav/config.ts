/**
 * CalDAV configuration: one optional env var, and the account credentials the
 * connector already holds.
 *
 * `EMAIL_IMAP_CALDAV_URL` is the only new setting. Calendar access reuses the
 * SAME email address and password as IMAP/SMTP — that is how Alibaba Mail (and
 * every other Basic-auth CalDAV provider the connector targets) works — so
 * there is no second credential to store, and the credentials are read from
 * the single in-memory `ClientConfig` that both the startup env path
 * (`src/index.ts` → `initClients`) and the runtime `configure_email_imap` path
 * populate. Nothing here reads `EMAIL_IMAP_EMAIL` / `EMAIL_IMAP_PASSWORD`
 * again: a second read would go stale the moment the user reconfigured the
 * account in-session.
 */

import { EmailImapError } from '../types.js';
import { getClientConfig } from '../tools/shared.js';
import { assertHttpsUrl, type CalDavCredentials } from './http.js';

export const CALDAV_URL_ENV = 'EMAIL_IMAP_CALDAV_URL';

/** Configured CalDAV URL, or `undefined` when unset/blank. */
export function readCalDavUrl(): string | undefined {
  const raw = process.env[CALDAV_URL_ENV];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Whether the calendar tools should exist at all. Read once at startup by
 * `createServer()`: a host that did not configure a calendar endpoint should
 * not see calendar tools in its tool list.
 */
export function isCalendarEnabled(): boolean {
  return readCalDavUrl() !== undefined;
}

/** Validated CalDAV base URL. Throws when unset or not HTTPS. */
export function requireCalDavUrl(): URL {
  const raw = readCalDavUrl();
  if (!raw) {
    throw new EmailImapError(
      'No calendar server is configured for this account.',
      'CALDAV_NOT_CONFIGURED',
      `Set ${CALDAV_URL_ENV} to the provider's CalDAV URL and restart the connector.`,
    );
  }
  return assertHttpsUrl(raw, CALDAV_URL_ENV);
}

/** The account credentials, or a structured error when none are configured. */
export function requireCalDavCredentials(): CalDavCredentials {
  const config = getClientConfig();
  if (!config || !config.email || !config.password) {
    throw new EmailImapError(
      'No email account is configured yet, so the calendar cannot be opened either.',
      'NOT_CONFIGURED',
      'Call configure_email_imap with the email address and password first — the calendar uses the same ones.',
    );
  }
  return { email: config.email, password: config.password };
}
