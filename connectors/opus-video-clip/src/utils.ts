import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OpusError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

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
  if (a === 100 && b >= 64 && b <= 127) return 'shared/CGNAT range (100.64.0.0/10, RFC 6598)';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking range (198.18.0.0/15)';
  if (a === 192 && b === 0 && c === 2) return 'documentation range (192.0.2.0/24, TEST-NET-1)';
  if (a === 198 && b === 51 && c === 100) return 'documentation range (198.51.100.0/24, TEST-NET-2)';
  if (a === 203 && b === 0 && c === 113) return 'documentation range (203.0.113.0/24, TEST-NET-3)';
  if (a === 192 && b === 88 && c === 99) return '6to4 relay range (192.88.99.0/24)';
  if (a === 192 && b === 0 && c === 0) return 'IETF protocol assignments (192.0.0.0/24)';
  if (a === 192 && b === 31 && c === 196) return 'AS112-v4 range (192.31.196.0/24)';
  if (a === 192 && b === 52 && c === 193) return 'AMT anycast range (192.52.193.0/24)';
  if (a === 192 && b === 175 && c === 48) return 'AS112 direct delegation (192.175.48.0/24)';
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
 * Returns a reason string when `host` (a hostname or IP literal, with or
 * without IPv6 brackets) names a loopback or non-public address, else
 * null. Plain DNS names return null — callers that fetch must additionally
 * run the DNS layer in `url-safety.ts`, which re-checks every resolved
 * address through this same classifier.
 */
export function nonPublicAddressReason(host: string): string | null {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '');

  if (lower === 'localhost' || lower === 'localhost.localdomain') return 'loopback hostname';
  if (lower.endsWith('.local')) return 'mDNS .local hostname';

  const v4 = parseIPv4(lower);
  if (v4) return privateIPv4Reason(v4);

  // IPv6 literals contain ':'. Hex-only DNS names (e.g. dead.cafe) never do.
  if (lower.includes(':') && /^[0-9a-f:.]+$/.test(lower)) {
    return privateIPv6Reason(lower);
  }

  return null;
}

/**
 * Validate that a hostname/URL is safe for outbound requests. Rejects
 * private/loopback/reserved IPs (the full non-public special-purpose
 * registry, IPv4 and IPv6), localhost, and non-HTTPS schemes.
 *
 * @returns The validated hostname (scheme stripped).
 * @throws OpusError if the hostname is unsafe.
 */
export function validateHostname(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new OpusError(
      'Hostname must not be empty.',
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  let hostname = trimmed;
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'https') {
      throw new OpusError(
        `Scheme "${scheme}" is not allowed. Only HTTPS is permitted.`,
        'INVALID_HOSTNAME',
        'Use an HTTPS URL.',
      );
    }
    hostname = trimmed.slice(schemeMatch[0].length);

    const atIndex = hostname.indexOf('@');
    if (atIndex !== -1) {
      hostname = hostname.slice(atIndex + 1);
    }

    hostname = hostname.split(/[:/]/)[0];
  } else {
    const bracketMatch = hostname.match(/^\[([^\]]+)\]/);
    if (bracketMatch) {
      hostname = bracketMatch[1];
    } else if ((hostname.match(/:/g) || []).length === 1) {
      hostname = hostname.slice(0, hostname.indexOf(':'));
    }
  }

  const lower = hostname.toLowerCase();

  if (lower === 'localhost') {
    throw new OpusError(
      'localhost is not allowed.',
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  if (lower === '::1' || lower === '[::1]') {
    throw new OpusError(
      'IPv6 loopback address is not allowed.',
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  const denyReason = nonPublicAddressReason(lower);
  if (denyReason) {
    throw new OpusError(
      `Private IP address "${hostname}" is not allowed.`,
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  return hostname;
}

/**
 * Wraps a tool handler with standard error handling.
 *
 *  - On success: returns the string result as a text content block.
 *  - On OpusError: returns a structured JSON error with code and resolution.
 *  - On unknown error: returns a generic error message.
 *
 * Secrets are never exposed in error messages.
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      if (error instanceof OpusError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: error.message,
                code: error.code,
                resolution: error.resolution,
              }),
            },
          ],
          isError: true,
        };
      }
      // Unknown errors (network/runtime) may embed upstream-controlled text
      // (e.g. a fetched URL inside a fetch failure message), so the message
      // is enveloped before it becomes model-visible — invariant #6.
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: wrapUntrusted(errorMessage, 'opus:unhandled-error') ?? 'Unknown error',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
