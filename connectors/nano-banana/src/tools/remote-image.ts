/**
 * Remote (https://) source-image fetching for `nano_banana_edit`.
 *
 * Security posture (SSRF hardening):
 *  - https:// only — plain http:// is refused.
 *  - URLs carrying userinfo (`https://user:pass@host/...`) are refused.
 *  - Private / loopback / link-local / reserved hosts are refused — the
 *    deny-list covers the full non-public special-purpose registry
 *    (incl. CGNAT 100.64.0.0/10, 192.0.0.0/24, IPv4-mapped IPv6) — and
 *    redirects are followed MANUALLY with every hop re-validated against
 *    the same rules (a 302 to an internal address is refused).
 *  - Hostnames (not just IP literals) are resolved via DNS and EVERY
 *    resolved address is re-checked against the deny-list; an
 *    unresolvable host fails closed. This closes the "public hostname
 *    that resolves/rebinds to a private address" bypass.
 *  - The response must declare a supported image Content-Type
 *    (PNG / JPEG / WebP) and stay under MAX_REMOTE_IMAGE_BYTES; the cap is
 *    enforced both on the Content-Length header (early) and while streaming
 *    the body (a lying header cannot overflow it).
 */

import { NanoBananaError } from '../types.js';

/**
 * Vendor guidance: keep individual reference images under ~20MB.
 */
export const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;

export const REMOTE_IMAGE_TIMEOUT_MS = 30_000;

const MAX_REDIRECTS = 3;

const CONTENT_TYPE_TO_MIME: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
};

export interface RemoteImage {
  mimeType: string;
  base64: string;
  bytes: number;
}

/**
 * Detect whether a user-supplied source image is a remote URL
 * (https:// / http://). Remote URLs bypass the local-file sandbox —
 * they never touch the filesystem.
 */
export function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

// ---------------------------------------------------------------------------
// Non-public address classification
// ---------------------------------------------------------------------------

const parseIPv4 = (value: string): [number, number, number, number] | null => {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1, 5).map((s) => Number(s));
  if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
};

/**
 * Returns a reason string if the IPv4 address is non-public, else null.
 * Covers the complete non-public special-purpose registry, not just the
 * RFC1918 trio — CGNAT (100.64.0.0/10), IETF protocol assignments
 * (192.0.0.0/24), benchmarking, documentation, multicast, and reserved
 * ranges are all reachable-or-abusable non-public space.
 */
const privateIPv4Reason = (octets: [number, number, number, number]): string | null => {
  const [a, b, c] = octets;
  if (a === 127) return 'loopback range (127.0.0.0/8)';
  if (a === 10) return 'RFC1918 private range (10.0.0.0/8)';
  if (a === 192 && b === 168) return 'RFC1918 private range (192.168.0.0/16)';
  if (a === 172 && b >= 16 && b <= 31) return 'RFC1918 private range (172.16.0.0/12)';
  if (a === 169 && b === 254) return 'link-local range (169.254.0.0/16, includes cloud metadata endpoints)';
  if (a === 0) return 'unspecified range (0.0.0.0/8)';
  // RFC 6598 shared address space — carrier-grade NAT, also used by overlay
  // networks: reachable non-public hosts.
  if (a === 100 && b >= 64 && b <= 127) return 'shared/CGNAT range (100.64.0.0/10, RFC 6598)';
  // Benchmarking (RFC 2544) — not publicly routable.
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking range (198.18.0.0/15)';
  // Documentation-only TEST-NETs; denying them keeps the guard fail-closed.
  if (a === 192 && b === 0 && c === 2) return 'documentation range (192.0.2.0/24, TEST-NET-1)';
  if (a === 198 && b === 51 && c === 100) return 'documentation range (198.51.100.0/24, TEST-NET-2)';
  if (a === 203 && b === 0 && c === 113) return 'documentation range (203.0.113.0/24, TEST-NET-3)';
  // Deprecated 6to4 relay anycast (RFC 7526).
  if (a === 192 && b === 88 && c === 99) return '6to4 relay range (192.88.99.0/24)';
  // Remaining IANA special-purpose /24s (IETF protocol assignments, AS112, AMT).
  if (a === 192 && b === 0 && c === 0) return 'IETF protocol assignments (192.0.0.0/24)';
  if (a === 192 && b === 31 && c === 196) return 'AS112-v4 range (192.31.196.0/24)';
  if (a === 192 && b === 52 && c === 193) return 'AMT anycast range (192.52.193.0/24)';
  if (a === 192 && b === 175 && c === 48) return 'AS112 direct delegation (192.175.48.0/24)';
  // Multicast (224.0.0.0/4) and reserved/broadcast (240.0.0.0/4).
  if (a >= 224 && a <= 239) return 'multicast range (224.0.0.0/4)';
  if (a >= 240) return 'reserved range (240.0.0.0/4)';
  return null;
};

/**
 * Returns a reason string if the IPv6 literal is non-public, else null.
 * Handles canonical IPv6, IPv4-mapped IPv6 in BOTH dotted (`::ffff:a.b.c.d`)
 * and hex (`::ffff:7f00:1` — the form WHATWG URL normalisation produces)
 * forms, unspecified `::`, loopback `::1`, link-local fe80::/10,
 * unique-local fc00::/7, and the IPv6 transition prefixes that embed an
 * IPv4 address (NAT64 64:ff9b::/96, 6to4 2002::/16, IPv4-compatible ::/96)
 * plus the discard-only 100::/64.
 */
const privateIPv6Reason = (raw: string): string | null => {
  const lower = raw.toLowerCase();

  if (lower === '::' || lower === '0:0:0:0:0:0:0:0' || lower === '0000:0000:0000:0000:0000:0000:0000:0000') {
    return 'IPv6 unspecified (::)';
  }
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1' || lower === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return 'IPv6 loopback (::1)';
  }

  // IPv4-mapped IPv6 in dotted form ::ffff:a.b.c.d
  const mappedDot = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDot) {
    const octets = parseIPv4(mappedDot[1]);
    if (!octets) return 'IPv4-mapped IPv6 (malformed)';
    const v4Reason = privateIPv4Reason(octets);
    return v4Reason ? `IPv4-mapped IPv6 (${v4Reason})` : null;
  }

  // IPv4-mapped IPv6 in hex form ::ffff:XXXX:YYYY — WHATWG URL parsing
  // normalises ::ffff:127.0.0.1 to ::ffff:7f00:1, so the hex form MUST be
  // handled or the mapped-v4 bypass stays open.
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const octets: [number, number, number, number] = [
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    ];
    const v4Reason = privateIPv4Reason(octets);
    return v4Reason ? `IPv4-mapped IPv6 (${v4Reason})` : null;
  }

  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return 'IPv6 link-local (fe80::/10)';
  // Unique-local fc00::/7
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return 'IPv6 unique-local (fc00::/7)';
  // Documentation-only prefix; denying it keeps the guard fail-closed.
  if (/^2001:0*db8(?::|$)/.test(lower)) return 'IPv6 documentation range (2001:db8::/32)';

  // IPv4-compatible IPv6 (::/96, deprecated by RFC 4291) — dotted and hex
  // forms not already caught by the :: / ::1 / ::ffff: handling above
  // (::7f00:1 is 127.0.0.1). The whole range is reserved: deny outright.
  if (/^::\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) {
    return 'IPv4-compatible IPv6 (::/96)';
  }
  if (
    /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower) ||
    /^(?:0+:){6}[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)
  ) {
    return 'IPv4-compatible IPv6 (::/96)';
  }

  // IPv6 transition prefixes embedding an IPv4 address in the low bits:
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052 — 64:ff9b::7f00:1 is
  // 127.0.0.1, 64:ff9b::a9fe:a9fe is the 169.254.169.254 IMDS) and 6to4
  // 2002::/16 (RFC 3056, deprecated by RFC 7526).
  if (/^0*64:0*ff9b(?::|$)/.test(lower)) return 'IPv6 NAT64 prefix (64:ff9b::/96, embeds IPv4)';
  if (/^0*2002(?::|$)/.test(lower)) return 'IPv6 6to4 range (2002::/16, embeds IPv4)';

  // Discard-only 100::/64 (RFC 6666).
  if (/^0*100::/.test(lower) || /^0*100:(?:0+:){3}/.test(lower)) {
    return 'IPv6 discard-only range (100::/64)';
  }

  return null;
};

/**
 * Synchronous (literal-only) check: returns a reason string when the
 * hostname is a loopback name or a non-public IP literal, else null.
 * Hostnames that are neither MUST additionally pass the DNS check in
 * `validateRemoteImageUrlWithDns`.
 */
function hostnameDenyReason(hostname: string): string | null {
  const lower = hostname.toLowerCase();

  if (lower === 'localhost' || lower === 'localhost.localdomain') return 'loopback hostname';
  if (lower.endsWith('.local')) return 'mDNS .local hostname';

  const v4 = parseIPv4(lower);
  if (v4) return privateIPv4Reason(v4);

  // IPv6 literals in URLs come bracketed; URL.hostname includes the brackets
  // in some Node versions and strips them in others — handle both.
  const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (bare.includes(':') && /^[0-9a-f:.]+$/.test(bare)) {
    return privateIPv6Reason(bare);
  }

  return null;
}

/**
 * Validate a remote source-image URL. Throws a NanoBananaError with code
 * URL_REJECTED on any failure. Every redirect hop is re-validated through
 * `validateRemoteImageUrlWithDns` before being followed.
 *
 * NOTE: this performs syntactic and IP-literal checks only; production
 * fetches use the async variant below, which additionally resolves the
 * hostname and re-checks every A/AAAA record.
 */
export function validateRemoteImageUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new NanoBananaError(
      'Invalid source image URL',
      'URL_REJECTED',
      'Pass a valid https:// URL pointing directly at a PNG, JPEG, or WebP image.',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new NanoBananaError(
      `Refusing non-HTTPS source image URL scheme '${parsed.protocol.replace(/:$/, '')}'`,
      'URL_REJECTED',
      'Only https:// URLs are supported for remote source images. Download the image into the workspace and pass a local path instead.',
    );
  }

  if (parsed.username || parsed.password) {
    throw new NanoBananaError(
      'Refusing source image URL containing userinfo (user:pass@host)',
      'URL_REJECTED',
      'Strip credentials from the URL; only plain https:// image URLs are accepted.',
    );
  }

  const denyReason = hostnameDenyReason(parsed.hostname);
  if (denyReason) {
    throw new NanoBananaError(
      `Refusing source image URL whose host is a non-public address (${denyReason})`,
      'URL_REJECTED',
      'Remote source images must be fetched from public hosts. Download the image into the workspace and pass a local path instead.',
    );
  }

  return parsed;
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
        timer = setTimeout(
          () => reject(new Error(`DNS lookup timed out`)),
          DNS_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Full async validation: the syntactic/literal checks of
 * `validateRemoteImageUrl`, PLUS DNS resolution of hostname URLs with
 * every resolved address re-checked against the non-public deny-list.
 * A hostname that cannot be resolved (or whose resolution stalls) is
 * REFUSED — an unverifiable host is never fetched.
 */
export async function validateRemoteImageUrlWithDns(input: string): Promise<URL> {
  const parsed = validateRemoteImageUrl(input);

  // IP literals were already fully classified by the synchronous check —
  // skip DNS. Must be a REAL IP check: a hex-only hostname (e.g. dead.cafe)
  // must not be misclassified as a literal and skip the DNS scan. WHATWG
  // URL parsing already normalises hex/octal/decimal IPv4 forms to
  // dotted-quad, so parseIPv4 catches those; net.isIP covers IPv6.
  const { isIP } = await import('node:net');
  const bare = parsed.hostname.replace(/^\[|\]$/g, '');
  if (parseIPv4(parsed.hostname) !== null || isIP(bare) !== 0) {
    return parsed;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupWithTimeout(parsed.hostname);
  } catch {
    // DNS failed or timed out: refuse rather than fetching a host we
    // cannot verify. Fail-closed by design.
    throw new NanoBananaError(
      'Source image URL hostname could not be resolved',
      'URL_REJECTED',
      'Verify the hostname is correct and publicly resolvable, then retry — or download the image into the workspace and pass a local path.',
    );
  }

  if (addresses.length === 0) {
    throw new NanoBananaError(
      'Source image URL hostname resolved to no addresses',
      'URL_REJECTED',
      'Verify the hostname is correct and publicly resolvable, then retry — or download the image into the workspace and pass a local path.',
    );
  }

  for (const { address } of addresses) {
    const v4 = parseIPv4(address);
    const reason = v4 ? privateIPv4Reason(v4) : privateIPv6Reason(address);
    if (reason) {
      throw new NanoBananaError(
        `Refusing source image URL whose host resolves to a non-public address (${reason})`,
        'URL_REJECTED',
        'Remote source images must be fetched from hosts whose DNS records all point at public addresses. Download the image into the workspace and pass a local path instead.',
      );
    }
  }

  return parsed;
}

function fetchFailure(message: string, resolution: string): NanoBananaError {
  return new NanoBananaError(message, 'REMOTE_IMAGE_FETCH_FAILED', resolution);
}

/**
 * Fetch a remote source image and return it base64-encoded.
 * Throws NanoBananaError (URL_REJECTED / REMOTE_IMAGE_FETCH_FAILED /
 * REMOTE_IMAGE_NOT_IMAGE / REMOTE_IMAGE_TOO_LARGE) on any failure.
 */
export async function fetchRemoteImage(input: string): Promise<RemoteImage> {
  let url = await validateRemoteImageUrlWithDns(input);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS),
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      throw fetchFailure(
        `Failed to fetch remote source image: ${errMsg}`,
        'Check the URL is reachable and points directly to a PNG/JPEG/WebP image, or download it into the workspace and pass a local path.',
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw fetchFailure(
          `Remote source image redirected (HTTP ${response.status}) without a Location header`,
          'Pass the final image URL directly.',
        );
      }
      // Re-validate every hop (including DNS): a redirect must not
      // downgrade to http:// or bounce to a private/internal host.
      url = await validateRemoteImageUrlWithDns(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw fetchFailure(
        `Failed to fetch remote source image (HTTP ${response.status})`,
        'Check the URL points directly at an image and is publicly reachable.',
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const mimeType = CONTENT_TYPE_TO_MIME[contentType];
    if (!mimeType) {
      // The Content-Type value is remote-server-controlled text; report the
      // expectation, never the raw header value.
      throw new NanoBananaError(
        'Remote URL did not return a supported image (expected a PNG, JPEG, or WebP Content-Type)',
        'REMOTE_IMAGE_NOT_IMAGE',
        'The URL must serve a PNG, JPEG, or WebP image.',
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) {
      throw new NanoBananaError(
        `Remote source image is too large (${declaredLength} bytes; max ${MAX_REMOTE_IMAGE_BYTES})`,
        'REMOTE_IMAGE_TOO_LARGE',
        'Use an image under 20MB, or download it into the workspace and pass a local path.',
      );
    }

    if (!response.body) {
      throw fetchFailure(
        'Remote source image response had no body',
        'Check the URL points directly at an image and is publicly reachable.',
      );
    }

    // Stream with a hard cap — a missing or lying Content-Length cannot
    // push the read past MAX_REMOTE_IMAGE_BYTES.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_IMAGE_BYTES) {
        // NB: not awaited — some mocked transports never settle cancel().
        reader.cancel().catch(() => undefined);
        throw new NanoBananaError(
          `Remote source image exceeded the ${MAX_REMOTE_IMAGE_BYTES}-byte limit while downloading`,
          'REMOTE_IMAGE_TOO_LARGE',
          'Use an image under 20MB, or download it into the workspace and pass a local path.',
        );
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    console.error(`[NanoBanana] Fetched remote source image: ${buffer.length} bytes, type: ${mimeType}`);
    return { mimeType, base64: buffer.toString('base64'), bytes: buffer.length };
  }

  throw fetchFailure(
    `Remote source image redirected more than ${MAX_REDIRECTS} times`,
    'Pass the final image URL directly.',
  );
}
