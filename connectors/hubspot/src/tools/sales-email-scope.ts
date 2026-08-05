/**
 * sales-email-read scope check for the 1:1 email read tools.
 *
 * HubSpot redacts 1:1 sales email bodies (hs_email_body / hs_email_html /
 * hs_email_text) unless the connected app holds the `sales-email-read` scope —
 * and it does so SILENTLY (200 with empty body fields). Silent redaction would
 * violate the connector's no-silent-degradation rule, so the email read tools
 * introspect the token and attach a model-visible `notes` warning:
 *
 * - scope definitively ABSENT  -> the redaction warning;
 * - scope definitively present -> no note;
 * - check INCONCLUSIVE (introspection failed, or the response carried no
 *   scope list) -> an "unverified" warning. An introspection outage must never
 *   degrade to silence.
 *
 * The definitive answer is memoised per access token (via the client's
 * tokenCacheKey), not per process: a reconnect or token rotation re-runs the
 * check, so a stale answer can't suppress the warning for a new credential or
 * preserve it after the scope was granted. An inconclusive check is never
 * memoised — the next call retries.
 */
import logger from '../utils/logger.js';

const SALES_EMAIL_READ_SCOPE = 'sales-email-read';

export const SALES_EMAIL_READ_NOTE =
  'Email bodies are redacted by HubSpot because the connected app does not have the sales-email-read scope. Subjects, senders, and timestamps are complete. To read bodies, enable sales-email-read on the HubSpot app and reconnect the account.';

export const SALES_EMAIL_SCOPE_UNKNOWN_NOTE =
  'Could not verify whether the connected HubSpot app has the sales-email-read scope (token introspection failed or did not report scopes). If email body fields are empty, HubSpot may be redacting them: enable sales-email-read on the HubSpot app and reconnect the account to read bodies.';

interface TokenInfoClient {
  readonly tokenCacheKey: string;
  getTokenInfo(): Promise<{ scopes?: string[] }>;
}

let scopeCache: { tokenCacheKey: string; granted: boolean } | undefined;
let scopeCheckInFlight: Promise<boolean | undefined> | undefined;

/**
 * Returns true/false on a definitive answer, undefined when introspection
 * can't say. The caller decides which warning (if any) to attach.
 */
export async function checkSalesEmailReadScope(
  getClient: () => Promise<TokenInfoClient>,
): Promise<boolean | undefined> {
  const client = await getClient();
  const cacheKey = client.tokenCacheKey;
  if (scopeCache && scopeCache.tokenCacheKey === cacheKey) return scopeCache.granted;

  if (!scopeCheckInFlight) {
    scopeCheckInFlight = (async () => {
      try {
        const info = await client.getTokenInfo();
        if (!Array.isArray(info.scopes)) return undefined; // introspection didn't say — caller warns
        return info.scopes.includes(SALES_EMAIL_READ_SCOPE);
      } catch (error) {
        logger.warn('Token introspection for sales-email-read scope check failed:', error);
        return undefined;
      }
    })();
  }
  const result = await scopeCheckInFlight;
  scopeCheckInFlight = undefined;
  // Only a definitive answer is memoised, keyed by the token it describes.
  if (result !== undefined) scopeCache = { tokenCacheKey: cacheKey, granted: result };
  return result;
}

/**
 * Attach the model-visible scope note: redaction warning when the scope is
 * definitively absent, unverified warning when the check couldn't say, no
 * note when it is present.
 */
export async function attachSalesEmailScopeNote<T extends object>(
  result: T,
  getClient: () => Promise<TokenInfoClient>,
): Promise<T & { notes?: string[] }> {
  const granted = await checkSalesEmailReadScope(getClient);
  if (granted === true) return result;
  return { ...result, notes: [granted === false ? SALES_EMAIL_READ_NOTE : SALES_EMAIL_SCOPE_UNKNOWN_NOTE] };
}

export function __resetSalesEmailScopeCacheForTests(): void {
  scopeCache = undefined;
  scopeCheckInFlight = undefined;
}
