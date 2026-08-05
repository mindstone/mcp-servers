/**
 * Exact-value credential redaction, complementing the key-based redaction in
 * `sanitize.ts`.
 *
 * Key-based redaction covers secrets reflected under credential-shaped keys,
 * but an upstream error can also quote a submitted credential inside free
 * text (`"Twilio rejected auth token abc123"`). The telephony import path
 * knows the exact credential values it sent, so it can strip those values
 * from anything — success payload or error message — before it becomes
 * model-visible. Replacement is a plain substring swap (no regex), so any
 * byte sequence the caller supplied is matched literally.
 */

const REDACTED = '[redacted]';

export function redactCredentialValues(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
