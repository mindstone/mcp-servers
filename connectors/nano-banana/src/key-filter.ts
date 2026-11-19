/**
 * The connector's credential filter. This file is the same in every connector
 * that has one (kling, nano-banana, opus-video-clip, runway): change it in all
 * of them together.
 *
 * Every credential the connector holds is passed to `rememberCredential`, and
 * from then on it is replaced with `[REDACTED]` in every outgoing MCP message
 * (`filterTransport`, wired in `server.ts`) and every stderr line
 * (`logError`). That includes errors the MCP SDK builds itself, such as
 * argument validation and unknown tools. Field-level redaction of vendor text
 * (`redactCredentials`) still runs before truncation, so a key cut in half at
 * a truncation boundary is caught too.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const REDACTED = '[REDACTED]';

/**
 * Credentials shorter than this are never filtered. Real keys are far longer;
 * an invalid short value such as `text` or `id` would otherwise rewrite
 * protocol member names and ordinary words in every message.
 */
const MIN_CREDENTIAL_LENGTH = 8;

/**
 * Every credential this process has held: keys from the environment, every
 * key a configure call submits (accepted or not) and any derived token. It
 * never shrinks, so a reply to a request made with an earlier key is still
 * filtered after that key is replaced.
 */
const credentials = new Set<string>();

export function rememberCredential(value: string): void {
  if (value.length >= MIN_CREDENTIAL_LENGTH) credentials.add(value);
}

/**
 * At least 8 printable ASCII characters, none of them `"`, `&`, `<`, `>` or
 * `\`. Every key format the providers publish fits (Kling and OpusClip publish
 * none). Such a key reads the same raw, JSON-escaped at
 * any depth and inside an untrusted-content envelope, so `redactCredentials`
 * finds every copy wherever a reply echoes it, and it is long enough to be
 * filtered at all.
 */
const PLAIN_CREDENTIAL = /^[\x21\x23-\x25\x27-\x3b\x3d\x3f-\x5b\x5d-\x7e]{8,}$/;

/**
 * The input schema for a credential a configure tool accepts. A value that
 * could not be a real key is refused before it is used or sent anywhere.
 */
export function credentialInput(description: string) {
  return z
    .string()
    .trim()
    .regex(
      PLAIN_CREDENTIAL,
      'This does not look like an API key: keys are at least 8 characters, with no spaces, quotes, backslashes or < > & characters. Copy the key again from the provider\'s website.',
    )
    .describe(description);
}

/**
 * Replace every remembered credential in `text` with `[REDACTED]`, longest
 * first so a credential containing another is removed whole. For each, the
 * JSON-escaped form goes first (as it appears inside JSON text), then the raw
 * form: for a key ending in `\`, replacing the raw form first would leave a
 * stray backslash behind.
 */
export function redactCredentials(text: string): string {
  let out = text;
  for (const credential of [...credentials].sort((a, b) => b.length - a.length)) {
    const escaped = JSON.stringify(credential).slice(1, -1);
    if (escaped !== credential) out = out.split(escaped).join(REDACTED);
    out = out.split(credential).join(REDACTED);
  }
  return out;
}

/**
 * Every string value and member name, at any depth. The decoded message is
 * filtered rather than its serialized text, so a match can never start inside
 * an escape sequence and leave invalid JSON behind.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactCredentials(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, member]) => [redactCredentials(name), redactDeep(member)]),
    );
  }
  return value;
}

/**
 * Filter everything the server sends through `transport`. The SDK's protocol
 * layer sends results, errors, notifications and requests only through
 * `transport.send`, so wrapping it before `connect` covers every outgoing
 * message. The JSON round trip gives exactly what the wire would carry
 * (`toJSON` applied, `undefined` dropped).
 */
export function filterTransport<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options) =>
    send(redactDeep(JSON.parse(JSON.stringify(message))) as JSONRPCMessage, options);
  return transport;
}

function formatLogPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part instanceof Error) return `${part.name}: ${part.message}`;
  return String(part);
}

/** The connector's stderr logger: one line, with every credential removed. */
export function logError(...parts: unknown[]): void {
  console.error(redactCredentials(parts.map(formatLogPart).join(' ')));
}
