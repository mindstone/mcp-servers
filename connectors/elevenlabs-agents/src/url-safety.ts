/**
 * Fail-closed validation for URLs this connector asks ElevenLabs to dereference
 * server-side — agent webhook tools (`add_agent_tool`) and knowledge-base URL
 * documents (`add_knowledge_base_document`).
 *
 * `z.string().url()` only checks shape: it accepts `javascript:`, `file:`, and
 * `http://169.254.169.254/latest/meta-data` alike. Registering such a URL would
 * make ElevenLabs' own infrastructure call it during conversations or document
 * ingestion, so the connector is the last security boundary that can refuse the
 * destination. The policy here is deliberately narrow:
 *
 * - `https:` only (no `http:`, no non-HTTP schemes, no embedded credentials).
 * - No IP-literal host in a loopback / private / link-local / CGNAT /
 *   benchmarking / documentation / multicast / reserved range — this includes
 *   the cloud-metadata address 169.254.169.254. The WHATWG parser normalises
 *   IPv4 shorthand (`127.1`, `0x7f000001`, integer forms) to dotted decimal, so
 *   one dotted-quad check covers the obfuscated spellings.
 * - No internal hostname spellings (`localhost`, `*.local`, `*.internal`, …)
 *   and no single-label names, which only resolve on an internal network.
 *   Trailing root-label dots are stripped before classification: the WHATWG
 *   parser preserves them, and `localhost.` is DNS-equivalent to `localhost`,
 *   so an unstripped comparison would miss that whole spelling class.
 *
 * What this cannot do: a public hostname may still resolve to an internal
 * address (DNS rebinding) or redirect there — but the fetch happens inside
 * ElevenLabs' network, not ours, so local resolution would prove nothing. The
 * fail-closed boundary is scheme + literal-IP/hostname classification (on the
 * trailing-dot-normalised hostname), and it is exactly that boundary the
 * checks below enforce.
 */

import { ElevenLabsError } from './types.js';

const BLOCKED_HOSTNAMES = new Set(['localhost']);

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.corp',
  '.home.arpa',
  '.localdomain',
  // RFC 2606 reserved TLDs never resolve to a public destination.
  '.test',
  '.example',
  '.invalid',
];

/**
 * True when `host` is a dotted-quad IPv4 literal in a non-public range.
 * Returns false for anything that is not a dotted quad (i.e. a hostname).
 */
function isNonPublicIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    octets.push(octet);
  }
  const a = octets[0];
  const b = octets[1];
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // protocol assignments / TEST-NET-1
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4)
  return false;
}

/**
 * True when `host` is an IPv6 literal (without brackets, lowercase, as the
 * WHATWG parser serialises it) that is not a public destination. Anything
 * malformed is treated as non-public (fail closed). IPv4-mapped and NAT64
 * addresses are rejected wholesale: a legitimate webhook host has A/AAAA
 * records, so a mapped literal is never needed.
 */
function isNonPublicIpv6(host: string): boolean {
  const parseGroups = (text: string): number[] | null => {
    if (text === '') return [];
    const groups: number[] = [];
    for (const part of text.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };

  const halves = host.split('::');
  if (halves.length > 2) return true;
  const head = parseGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) return true;

  let hextets: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return true;
    hextets = [...head, ...Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return true;
    hextets = head;
  }

  const h0 = hextets[0];
  const h1 = hextets[1];
  const h5 = hextets[5];
  const h7 = hextets[7];

  if (hextets.every((h) => h === 0)) return true; // :: unspecified
  if (hextets.slice(0, 7).every((h) => h === 0) && h7 === 1) return true; // ::1 loopback
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h0 === 0 && h1 === 0 && h5 === 0xffff) return true; // IPv4-mapped ::ffff:0:0/96
  if (h0 === 0x64 && h1 === 0xff9b) return true; // NAT64 64:ff9b::/96
  return false;
}

/**
 * Throw unless `value` is a public `https:` URL. `field` names the tool
 * argument for the error message. URLs may contain `{path_param}` placeholders
 * in the path/query (ElevenLabs webhook syntax); placeholders in the hostname
 * fail URL parsing and are therefore rejected.
 */
export function validatePublicHttpsUrl(field: string, value: string): void {
  const fail = (reason: string): never => {
    throw new ElevenLabsError(
      `${field} must be a public https URL: ${reason}.`,
      'INVALID_URL',
      'Use an https:// URL on a public hostname. Loopback, private, link-local, and cloud-metadata addresses are not allowed.',
    );
  };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('it is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    fail(`scheme "${parsed.protocol.replace(/:$/, '')}" is not https`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    fail('embedded credentials are not allowed');
  }

  // The WHATWG parser preserves terminal root-label dots on hostnames
  // (`localhost.` stays `localhost.`), and `localhost.` is DNS-equivalent to
  // `localhost`, so every classification below runs on the hostname with all
  // trailing dots stripped. Stripping is fail-closed — no legitimate webhook
  // host needs a trailing dot, and `localhost..` normalises the same way.
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (hostname === '') fail('the hostname is empty');

  if (hostname.startsWith('[')) {
    if (isNonPublicIpv6(hostname.slice(1, -1))) {
      fail('the IPv6 address is loopback, private, link-local, or otherwise non-public');
    }
    return;
  }
  if (isNonPublicIpv4(hostname)) {
    fail('the IPv4 address is loopback, private, link-local, or otherwise non-public');
  }
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_HOSTNAME_SUFFIXES.some((s) => hostname.endsWith(s))) {
    fail(`"${hostname}" is an internal or reserved hostname`);
  }
  if (!hostname.includes('.')) {
    fail('single-label hostnames resolve only on internal networks');
  }
}

/**
 * Recursive form of `validatePublicHttpsUrl` for caller-shaped passthrough bodies
 * (the agent authoring tools' `advanced_config`). ElevenLabs dereferences URL
 * fields inside the agent config server-side —
 * `conversation_config.agent.prompt.custom_llm.url` is fetched on every
 * conversation turn and `platform_settings` carries conversation-initiation
 * webhook URLs — and the exact set drifts with the upstream schema, so rather
 * than enumerate fields every `url`-keyed string anywhere in the merged body
 * gets the same fail-closed policy before the body leaves the connector.
 * Over-inclusion fails closed (a URL ElevenLabs never fetches must still be a
 * public https destination — cosmetic strictness); under-inclusion re-opens the
 * SSRF door this module exists to close.
 */
export function validateNestedPublicHttpsUrls(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNestedPublicHttpsUrls(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (key.toLowerCase() === 'url' && typeof entry === 'string') {
      validatePublicHttpsUrl(childPath, entry);
    } else {
      validateNestedPublicHttpsUrls(entry, childPath);
    }
  }
}
