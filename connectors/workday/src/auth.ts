/**
 * Workday authentication module.
 *
 * OAuth2 dual grant type: client_credentials (default) + refresh_token (when available).
 * Credentials managed via env vars or configured at runtime.
 *
 * Environment variables:
 * - WORKDAY_HOST: Workday API domain (e.g., wd5-impl-services1.workday.com)
 * - WORKDAY_TENANT: Customer's Workday tenant name
 * - WORKDAY_CLIENT_ID: OAuth client ID
 * - WORKDAY_CLIENT_SECRET: OAuth client secret
 * - WORKDAY_REFRESH_TOKEN: Optional refresh token (enables refresh_token grant)
 */

import { isIP } from 'node:net';

import { z } from 'zod';

import { WorkdayError, USER_AGENT, REQUEST_TIMEOUT_MS, RECRUITING_API_VERSION_DEFAULT } from './types.js';
import { bridgeRequest } from './bridge.js';

// ── Runtime credentials ──

let workdayHost: string = '';
let workdayTenant: string = process.env.WORKDAY_TENANT ?? '';
let clientId: string = process.env.WORKDAY_CLIENT_ID ?? '';
let clientSecret: string = process.env.WORKDAY_CLIENT_SECRET ?? '';
let refreshToken: string = process.env.WORKDAY_REFRESH_TOKEN ?? '';

// ── Token cache ──

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

// ── Getters / setters ──

export function getHost(): string {
  return workdayHost;
}

export function setHost(h: string): void {
  workdayHost = h;
}

// The tenant is interpolated raw into URL paths (token URL, API base URLs),
// so confine it to the tenant-name charset — anything else could smuggle path
// segments or URL metacharacters into credential-bearing requests.
export const TENANT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function getTenant(): string {
  return workdayTenant;
}

export function setTenant(t: string): void {
  workdayTenant = t;
}

export function getClientId(): string {
  return clientId;
}

export function setClientId(id: string): void {
  clientId = id;
}

export function getClientSecret(): string {
  return clientSecret;
}

export function setClientSecret(s: string): void {
  clientSecret = s;
}

export function getRefreshToken(): string {
  return refreshToken;
}

export function setRefreshToken(t: string): void {
  refreshToken = t;
}

export function clearTokenCache(): void {
  cachedAccessToken = null;
  tokenExpiresAt = 0;
}

export function isConfigured(): boolean {
  return !!(workdayHost && workdayTenant && clientId && clientSecret);
}

export function getTokenUrl(): string {
  return `https://${workdayHost}/ccx/oauth2/${workdayTenant}/token`;
}

export function getApiBaseUrl(): string {
  return `https://${workdayHost}/ccx/api/v1/${workdayTenant}`;
}

// Workday's wider REST surface is split into per-domain service families
// (e.g. absenceManagement/v1, payroll/v2) that hang off /ccx/api/ rather
// than the /ccx/api/v1/{tenant} alias used for the core worker/org endpoints.
export function getServiceApiBaseUrl(serviceFamily: string): string {
  return `https://${workdayHost}/ccx/api/${serviceFamily}/${workdayTenant}`;
}

// Recruiting REST family, with the platform-release version segment
// overridable because tenants on different Workday releases expose
// different versions.
export function getRecruitingApiFamily(): string {
  const raw = (process.env.WORKDAY_RECRUITING_API_VERSION ?? '').trim();
  if (!raw) return `recruiting/${RECRUITING_API_VERSION_DEFAULT}`;
  if (!/^v\d+(\.\d+)?$/.test(raw)) {
    console.error('[Workday] Ignoring invalid WORKDAY_RECRUITING_API_VERSION (expected e.g. "v41.2")');
    return `recruiting/${RECRUITING_API_VERSION_DEFAULT}`;
  }
  return `recruiting/${raw}`;
}

// ── SSRF / Host validation ──

function normalizeHost(raw: string): string {
  let host = raw.trim();
  host = host.replace(/^https?:\/\//i, '');
  host = host.replace(/\/+$/, '');
  return host;
}

const parseIPv4 = (value: string): [number, number, number, number] | null => {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1, 5).map((s) => Number(s));
  if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
};

// Returns a reason string when the IPv4 octets are non-public, else null.
const privateIPv4Reason = (octets: [number, number, number, number]): string | null => {
  const [a, b, c] = octets;
  if (a === 127) return 'loopback range (127.0.0.0/8)';
  if (a === 10) return 'RFC1918 private range (10.0.0.0/8)';
  if (a === 172 && b >= 16 && b <= 31) return 'RFC1918 private range (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'RFC1918 private range (192.168.0.0/16)';
  if (a === 169 && b === 254) return 'link-local range (169.254.0.0/16, includes IMDS)';
  if (a === 0) return 'unspecified range (0.0.0.0/8)';
  // RFC 6598 shared address space — carrier-grade NAT, also used by overlay networks.
  if (a === 100 && b >= 64 && b <= 127) return 'shared/CGNAT range (100.64.0.0/10, RFC 6598)';
  // Benchmarking (RFC 2544) — not publicly routable.
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking range (198.18.0.0/15)';
  // Documentation-only TEST-NETs; denying them keeps this guard fail-closed.
  if (a === 192 && b === 0 && c === 2) return 'documentation range (192.0.2.0/24, TEST-NET-1)';
  if (a === 198 && b === 51 && c === 100) return 'documentation range (198.51.100.0/24, TEST-NET-2)';
  if (a === 203 && b === 0 && c === 113) return 'documentation range (203.0.113.0/24, TEST-NET-3)';
  // Deprecated 6to4 relay anycast (RFC 7526).
  if (a === 192 && b === 88 && c === 99) return '6to4 relay range (192.88.99.0/24)';
  // Multicast (224.0.0.0/4) and reserved/broadcast (240.0.0.0/4).
  if (a >= 224 && a <= 239) return 'multicast range (224.0.0.0/4)';
  if (a >= 240) return 'reserved range (240.0.0.0/4)';
  return null;
};

// Returns a reason string when the IPv6 literal is non-routable, else null.
const privateIPv6Reason = (raw: string): string | null => {
  const lower = raw.toLowerCase();

  if (lower === '::') return 'IPv6 unspecified (::)';
  if (
    lower === '::1' ||
    lower === '0:0:0:0:0:0:0:1' ||
    lower === '0000:0000:0000:0000:0000:0000:0000:0001'
  ) {
    return 'IPv6 loopback (::1)';
  }

  // IPv4-mapped IPv6, dotted form (::ffff:127.0.0.1).
  const mappedDot = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDot) {
    const octets = parseIPv4(mappedDot[1]);
    if (!octets) return 'IPv4-mapped IPv6 (malformed)';
    const v4Reason = privateIPv4Reason(octets);
    return v4Reason ? `IPv4-mapped IPv6 (${v4Reason})` : null;
  }

  // IPv4-mapped IPv6, hex form — WHATWG URL normalizes ::ffff:127.0.0.1 to
  // ::ffff:7f00:1, so the hex form must be handled too.
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi <= 0xffff && lo <= 0xffff) {
      const octets: [number, number, number, number] = [
        (hi >> 8) & 0xff,
        hi & 0xff,
        (lo >> 8) & 0xff,
        lo & 0xff,
      ];
      const v4Reason = privateIPv4Reason(octets);
      return v4Reason ? `IPv4-mapped IPv6 (${v4Reason})` : null;
    }
  }

  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return 'IPv6 link-local (fe80::/10)';
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return 'IPv6 unique-local (fc00::/7)';
  if (/^2001:0*db8(?::|$)/.test(lower)) return 'IPv6 documentation range (2001:db8::/32)';

  // IPv6 transition prefixes embed an IPv4 address in the low bits — a v4
  // literal smuggled through one of these forms would bypass the IPv4 checks.
  if (/^64:0*ff9b(?::|$)/.test(lower)) return 'NAT64 well-known prefix (64:ff9b::/96)';
  if (/^2002:/.test(lower)) return '6to4 transition prefix (2002::/16)';
  if (/^100::/.test(lower)) return 'IPv6 discard-only prefix (100::/64)';
  // IPv4-translated SIIT (::ffff:0:0/96, RFC 2765) — three groups after
  // ::ffff:, so the mapped forms above don't see it. Teredo (2001::/32)
  // embeds the server IPv4 raw; both mechanisms are defunct, so deny flatly.
  if (/^::ffff:0(?::|$)/.test(lower)) return 'IPv4-translated IPv6 (::ffff:0:0/96)';
  if (/^2001:0*:/.test(lower)) return 'Teredo tunneling prefix (2001::/32)';
  // IPv4-compatible IPv6 (::/96, deprecated by RFC 4291) — `::`, `::1`, and
  // the ::ffff: mapped forms are already handled above; deny the rest
  // (dotted and hex spellings alike — WHATWG URL normalizes `::127.0.0.1`
  // to `::7f00:1`).
  if (/^::(?:[0-9a-f]{1,4}:)?[0-9a-f]{1,4}$/.test(lower)) return 'IPv4-compatible IPv6 (::/96)';
  if (/^::\d{1,3}(?:\.\d{1,3}){3}$/.test(lower)) return 'IPv4-compatible IPv6 (::/96)';

  return null;
};

// Returns a reason string when a normalized hostname is non-public, else null.
const nonPublicHostReason = (hostname: string): string | null => {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === 'localhost.localdomain') return 'loopback hostname';

  const v4 = parseIPv4(lower);
  if (v4) return privateIPv4Reason(v4);

  // IPv6 literals arrive bracketed from URL.hostname; also accept raw forms.
  const bare = lower.replace(/^\[|\]$/g, '');
  if (bare.includes(':') && isIP(bare) === 6) return privateIPv6Reason(bare);

  return null;
};

export function validateHost(rawHost: string): { valid: boolean; host?: string; error?: string } {
  const host = normalizeHost(rawHost);
  if (!host || host.length === 0) {
    return { valid: false, error: 'Host is required.' };
  }

  // Refuse an explicit port even when it equals the https default — WHATWG
  // URL parsing normalizes `host:443` away, so the `url.port` check below
  // cannot see it. (Bare IPv6 without brackets also matches; it is invalid
  // URL host syntax and would be refused below regardless.)
  if (/:\d*$/.test(host)) {
    return { valid: false, error: 'Host must be a bare hostname (no port, path, or credentials).' };
  }

  // WHATWG URL parsing normalizes non-canonical IPv4 spellings (127.1,
  // 0x7f000001, 2130706433, 0177.0.0.1) to dotted-quad, so loopback/private
  // literals in disguise cannot slip past the checks below.
  let url: URL;
  try {
    url = new URL(`https://${host}`);
  } catch {
    return { valid: false, error: 'Host must be a valid hostname.' };
  }
  if (url.username || url.password || url.port || url.pathname !== '/') {
    return { valid: false, error: 'Host must be a bare hostname (no port, path, or credentials).' };
  }

  const normalized = url.hostname;
  const reason = nonPublicHostReason(normalized);
  if (reason) {
    return { valid: false, error: `Host must not be localhost or a private IP address (${reason}).` };
  }

  if (normalized.length < 2 || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(normalized)) {
    return { valid: false, error: 'Host must be a valid hostname.' };
  }

  return { valid: true, host: normalized };
}

// ── DNS re-resolution guard ──
//
// A syntactically public hostname can still resolve to a private address
// (split-horizon DNS, DNS rebinding). Before any credential-bearing request,
// resolve the host and re-check every A/AAAA record against the same
// non-public deny list. Fail-closed: an unresolvable host is refused.
//
// Call sites: getAccessToken (Basic credential, below) and workdayFetch in
// client.ts (bearer token — the token cache short-circuits the check here, so
// data requests must re-run the guard themselves). Best-effort by nature:
// fetch resolves the name again independently, so a record flipped between
// the guard and the connect is not caught; closing that fully would require
// pinning the resolved IP via a custom dispatcher, which undici does not
// expose through the global fetch used here.

export type DnsLookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultDnsLookup: DnsLookupFn = async (hostname) => {
  const dns = await import('node:dns/promises');
  return dns.lookup(hostname, { all: true });
};

// Test seam: ESM module namespaces can't be spied on with vi.spyOn().
let dnsLookupImpl: DnsLookupFn = defaultDnsLookup;
export function setDnsLookupForTesting(fn: DnsLookupFn | null): void {
  dnsLookupImpl = fn ?? defaultDnsLookup;
}

// dns.lookup has no abort signal; a stuck resolver must not hang a tool call.
const DNS_LOOKUP_TIMEOUT_MS = 10_000;

const lookupWithTimeout = async (
  hostname: string,
): Promise<Array<{ address: string; family: number }>> => {
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
};

const nonPublicAddressReason = (address: string): string | null => {
  const v4 = parseIPv4(address);
  if (v4) return privateIPv4Reason(v4);
  if (isIP(address) === 6) return privateIPv6Reason(address.toLowerCase());
  return 'unrecognized address family';
};

export async function assertHostResolvesPublic(host: string): Promise<void> {
  // Literal IPs were already validated by validateHost; skip DNS.
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return;

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupWithTimeout(host);
  } catch {
    throw new WorkdayError(
      'Workday host could not be resolved.',
      'HOST_UNRESOLVABLE',
      'Verify the host domain is correct and publicly resolvable, then retry.',
    );
  }

  for (const { address } of addresses) {
    if (nonPublicAddressReason(address)) {
      throw new WorkdayError(
        'Workday host resolves to a non-public address, which is refused.',
        'HOST_NOT_PUBLIC',
        'Internal, loopback, link-local, or private-network addresses are refused. Verify the host domain.',
      );
    }
  }
}

// Validate WORKDAY_TENANT from env at startup — it is interpolated raw into
// URL paths, so refuse anything outside the tenant-name charset (mirrors the
// WORKDAY_HOST validation below).
if (workdayTenant && !TENANT_NAME_PATTERN.test(workdayTenant)) {
  console.error('[Workday] Ignoring invalid WORKDAY_TENANT from env (letters, digits, "_" and "-" only).');
  workdayTenant = '';
}

// Validate WORKDAY_HOST from env at startup — reject private/localhost hosts.
// (Lives below the SSRF section because validateHost closes over const helpers
// defined there.)
const _envHost = process.env.WORKDAY_HOST ?? '';
if (_envHost) {
  const _hostResult = validateHost(_envHost);
  if (_hostResult.valid) {
    workdayHost = _hostResult.host!;
  } else {
    console.error(`[Workday] Ignoring invalid WORKDAY_HOST from env: ${_hostResult.error}`);
  }
}

// ── Token exchange ──

// The token body is vendor/proxy-controlled. Validate it before caching: a
// hostile endpoint could return an absurd expires_in (pinning the cached
// token open for the process lifetime) or a malformed/missing access_token.
// Bounds: 60s-24h. Below 60s the 60-second cache skew would force a
// re-exchange on every call anyway; above 24h a stolen token stays usable
// far beyond any legitimate Workday lifetime (real tokens last ~1h).
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().min(60).max(86_400),
  refresh_token: z.string().min(1).optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export function parseTokenResponse(data: unknown): TokenResponse {
  const parsed = tokenResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new WorkdayError(
      'OAuth token endpoint returned a malformed or out-of-bounds response.',
      'AUTH_FAILED',
      'Re-configure with configure_workday_credentials. If the problem persists, check the API Client registration in Workday.',
    );
  }
  return parsed.data;
}

export async function getAccessToken(): Promise<string> {
  if (!clientId || !clientSecret) {
    throw new WorkdayError(
      'Workday not configured. Call configure_workday_credentials first.',
      'NOT_CONFIGURED',
      'Configure Workday with your OAuth credentials first.',
    );
  }

  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  // Re-resolve the host and refuse non-public records before any
  // credential-bearing request leaves the process.
  await assertHostResolvesPublic(workdayHost);

  const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const bodyParams: Record<string, string> = refreshToken
    ? { grant_type: 'refresh_token', refresh_token: refreshToken }
    : { grant_type: 'client_credentials' };

  const body = new URLSearchParams(bodyParams);

  let response: Response;
  try {
    response = await fetch(getTokenUrl(), {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
      // Never auto-follow redirects: a vendor/proxy-controlled Location header
      // would replay the Basic-auth credential to an arbitrary host.
      redirect: 'manual',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new WorkdayError(
        'OAuth token request timed out',
        'TIMEOUT',
        'The request took too long. Check your Workday host and network connectivity.',
      );
    }
    throw error;
  }

  if (!response.ok) {
    // The OAuth error body (error / error_description / raw text) is
    // vendor/proxy-controlled and may reflect request data, including the
    // credentials just sent — never propagate it. Bounded, connector-authored
    // messages only.
    console.error(`[Workday] OAuth token exchange failed (HTTP ${response.status})`);
    if (response.status >= 300 && response.status < 400) {
      throw new WorkdayError(
        `OAuth token endpoint attempted a redirect (HTTP ${response.status}), which was refused.`,
        'AUTH_FAILED',
        'The token endpoint returned an unexpected redirect. Verify the configured host is correct.',
      );
    }
    throw new WorkdayError(
      `OAuth token exchange failed (${response.status}).`,
      'AUTH_FAILED',
      'Re-configure with configure_workday_credentials. Check client ID, secret, and tenant.',
    );
  }

  const tokenData = parseTokenResponse(await response.json());

  cachedAccessToken = tokenData.access_token;
  tokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;

  // Handle refresh token rotation
  if (tokenData.refresh_token && tokenData.refresh_token !== refreshToken) {
    refreshToken = tokenData.refresh_token;
    bridgeRequest('/bundled/workday/update-refresh-token', {
      refreshToken: tokenData.refresh_token,
    }).catch(() => {
      // The rotated token stays in memory and is used for this process'
      // lifetime; only cross-restart persistence failed. Log a bounded,
      // connector-authored message — never an arbitrary thrown error string.
      console.error('[Workday] Failed to persist rotated refresh token via bridge.');
    });
  }

  return cachedAccessToken;
}
