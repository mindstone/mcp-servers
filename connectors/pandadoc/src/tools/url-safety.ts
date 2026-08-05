/**
 * Host validation for `create_document_from_url`.
 *
 * PandaDoc fetches the supplied URL SERVER-SIDE, so the tool is an indirect
 * fetch primitive: without host classification, a caller could hand PandaDoc
 * a link-local / loopback / private-range destination (cloud metadata
 * endpoints, internal services). DNS resolution and redirect following
 * happen inside PandaDoc's infrastructure and are vendor-side
 * responsibilities; what the connector can and must do is refuse URLs whose
 * literal host is already internal, and refuse credential-bearing URLs.
 */

/** Returns true when `host` is an IPv4 literal in a non-public range. */
function isNonPublicIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return false; // not a valid literal; treated as a hostname
  const [a, b] = octets;
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0) || // IETF protocol assignments / TEST-NET-1
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && octets[2] === 100) || // TEST-NET-2
    (a === 203 && b === 0 && octets[2] === 113) || // TEST-NET-3
    a >= 224 // multicast + reserved
  );
}

/** Expand an IPv6 literal (without brackets) into its eight 16-bit groups, or null if invalid. */
function expandIpv6(inner: string): number[] | null {
  const noZone = inner.split('%')[0];
  let body = noZone;
  let v4Groups: number[] = [];
  const v4Match = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(noZone);
  if (v4Match) {
    const octets = v4Match[1].split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    v4Groups = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    body = noZone.slice(0, noZone.length - v4Match[1].length).replace(/:$/, '');
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const present = head.length + tail.length + v4Groups.length;
  if (halves.length === 1 && present !== 8) return null;
  if (halves.length === 2 && present > 7) return null;
  const zeros = new Array<number>(8 - present).fill(0);
  return [
    ...head.map((g) => parseInt(g, 16)),
    ...zeros,
    ...tail.map((g) => parseInt(g, 16)),
    ...v4Groups,
  ];
}

/** Returns true when `host` is an IPv6 literal in a non-public range. */
function isNonPublicIpv6(host: string): boolean {
  // URL.hostname keeps the brackets on IPv6 literals.
  const groups = expandIpv6(host.replace(/^\[|\]$/g, '').toLowerCase());
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  // IPv4-mapped / compatible: defer to the IPv4 rules.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isNonPublicIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true; // unique local fc00::/7
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true; // link-local fe80::/10
  if (g0 >= 0xff00) return true; // multicast ff00::/8
  return false;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.lan'];

/**
 * Validate that `rawUrl` is an HTTPS URL whose literal host is public.
 * Returns `null` when acceptable, otherwise a human-readable reason.
 */
export function validatePublicHttpsUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'url is not a valid URL';
  }
  if (parsed.protocol !== 'https:') {
    return 'url must be HTTPS';
  }
  if (parsed.username || parsed.password) {
    return 'url must not contain embedded credentials';
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    return 'url must contain a host';
  }
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOSTNAME_SUFFIXES.some((s) => host.endsWith(s))) {
    return `url host "${host}" is not a public host`;
  }
  if (isNonPublicIpv4(host) || isNonPublicIpv6(host)) {
    return `url host "${host}" is a private, loopback, link-local, or reserved address`;
  }
  return null;
}
