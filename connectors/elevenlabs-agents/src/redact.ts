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
 *
 * Substring replacement against an already-serialized payload is only safe
 * when the secret can never look like payload structure: a credential of `"`
 * would replace every JSON delimiter and corrupt the output. Defences apply on
 * both sides — submitted Twilio credentials are format-validated at the tool
 * boundary (`AC` + 32 hex / 32 hex, no JSON syntax characters), the SIP trunk
 * collector skips values containing JSON string delimiters, and secrets shorter
 * than `MIN_REDACTABLE_SECRET_LENGTH` are skipped here, so a too-short value
 * from a future caller degrades to "not redacted" rather than "payload
 * mangled". (Values under credential-shaped keys are redacted by the sanitizer
 * regardless of length.)
 */

const REDACTED = '[redacted]';

const MIN_REDACTABLE_SECRET_LENGTH = 8;

export function redactCredentialValues(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
