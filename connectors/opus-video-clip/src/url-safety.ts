/**
 * SSRF defence for the connector's two non-API outbound URL families:
 *
 *  - `opus_download_clip` — user-supplied `uriForExport` URLs. Allowed
 *    hosts are the documented Opus CDN and Google Cloud Storage signed-URL
 *    hosts; everything else is refused.
 *  - `opus_upload_video` — upstream-supplied GCS initiation/session URLs.
 *    Same GCS allow-list; a poisoned Opus response must not be able to
 *    point the upload (or the connector's fetch in general) at an
 *    arbitrary host.
 *
 * Validation layers, applied to the initial URL and every redirect hop:
 *  1. Syntax: HTTPS only, no userinfo.
 *  2. Literal: non-public IP literals (full special-purpose registry,
 *     IPv4 and IPv6 incl. IPv4-mapped forms) refused via
 *     `nonPublicAddressReason`. WHATWG URL parsing normalises
 *     decimal/octal/hex IPv4 forms before this check runs.
 *  3. Allow-list: the hostname must be (a subdomain of) an allowed vendor
 *     host — lookalikes (`opus.pro.evil.example`) are rejected.
 *  4. DNS: hostnames are resolved and EVERY A/AAAA record is re-checked
 *     against the non-public classifier; an unresolvable host fails
 *     closed. This closes the "public-looking hostname that resolves to
 *     a private/metadata address" bypass. (Resolution and the subsequent
 *     connect are separate lookups, so a sub-second rebind window remains
 *     — the vendor allow-list bounds what a rebinder can be asked to
 *     reach, and connect-time pinning is not available through the
 *     runtime's global fetch.)
 *
 * Error strings deliberately never echo the URL: signed CDN query strings
 * in a rejected URL must not be copied into model-visible output.
 */

import { nonPublicAddressReason } from './utils.js';

/** Hosts allowed to serve clip downloads (Opus CDN + GCS signed URLs). */
export const DOWNLOAD_ALLOWED_HOST_SUFFIXES = [
  'opus.pro',
  'storage.googleapis.com',
  'storage.cloud.google.com',
] as const;

/** Hosts allowed to receive GCS resumable uploads (upstream-provided). */
export const UPLOAD_ALLOWED_HOST_SUFFIXES = [
  'storage.googleapis.com',
  'storage.cloud.google.com',
] as const;

function isAllowedHost(hostname: string, allowedSuffixes: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Synchronous validation: HTTPS syntax, userinfo, non-public literals,
 * and the vendor host allow-list. Returns null when valid, an error
 * string otherwise.
 */
export function validateOutboundUrlSync(
  url: string,
  allowedSuffixes: readonly string[],
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL.';
  }

  if (parsed.protocol !== 'https:') {
    return 'Only HTTPS URLs are supported.';
  }

  if (parsed.username || parsed.password) {
    return 'URLs with embedded credentials (user:pass@host) are not allowed.';
  }

  const literalReason = nonPublicAddressReason(parsed.hostname);
  if (literalReason) {
    return `The URL host is a non-public address (${literalReason}).`;
  }

  if (!isAllowedHost(parsed.hostname, allowedSuffixes)) {
    return `The URL host is not an allowed OpusClip / Google Cloud Storage host (${allowedSuffixes.join(', ')}).`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// DNS anti-rebinding layer
// ---------------------------------------------------------------------------

export type DnsLookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultDnsLookup: DnsLookupFn = async (hostname) => {
  const dns = await import('node:dns/promises');
  return dns.lookup(hostname, { all: true });
};

// Test seam: tests inject a custom lookup via setDnsLookupForTesting()
// because ESM module namespaces can't be spied on with vi.spyOn().
let dnsLookupImpl: DnsLookupFn = defaultDnsLookup;
export function setDnsLookupForTesting(fn: DnsLookupFn | null): void {
  dnsLookupImpl = fn ?? defaultDnsLookup;
}

// dns.lookup has no abort signal; a stuck resolver must not hang the fetch
// past its documented budget, so bound the wait ourselves.
const DNS_LOOKUP_TIMEOUT_MS = 10_000;

async function lookupWithTimeout(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dnsLookupImpl(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), DNS_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Full async validation: the synchronous checks of
 * `validateOutboundUrlSync`, PLUS DNS resolution with every resolved
 * address re-checked against the non-public classifier. A hostname that
 * cannot be resolved (or whose resolution stalls) is REFUSED — an
 * unverifiable host is never fetched. Returns null when valid, an error
 * string otherwise.
 */
export async function validateOutboundUrlWithDns(
  url: string,
  allowedSuffixes: readonly string[],
): Promise<string | null> {
  const syncError = validateOutboundUrlSync(url, allowedSuffixes);
  if (syncError) return syncError;

  const parsed = new URL(url);

  // IP literals were already fully classified by the synchronous check —
  // skip DNS. WHATWG URL parsing already normalises decimal/octal/hex
  // IPv4 forms to dotted-quad, and net.isIP covers IPv6.
  const { isIP } = await import('node:net');
  const bare = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0) {
    return null;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupWithTimeout(parsed.hostname);
  } catch {
    // DNS failed or timed out: refuse rather than fetching a host we
    // cannot verify. Fail-closed by design.
    return 'The URL hostname could not be resolved to a verifiable public address.';
  }

  if (addresses.length === 0) {
    return 'The URL hostname resolved to no addresses.';
  }

  for (const { address } of addresses) {
    const reason = nonPublicAddressReason(address);
    if (reason) {
      return `The URL host resolves to a non-public address (${reason}).`;
    }
  }

  return null;
}
