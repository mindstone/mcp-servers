/**
 * Envelope third-party API error `detail` strings before they reach model-visible
 * tool error output (message + resolution). FastAPI-422 flattening stays intact —
 * we wrap the flattened string, we do not discard field-path usefulness.
 */
import { wrapUntrusted } from './untrusted-content.js';

const ERROR_DETAIL_SOURCE = 'elevenlabs:api:error_detail';

/** Wrap API-authored error detail for inclusion in ElevenLabsError message/resolution. */
export function envelopeApiErrorDetail(detail: string): string {
  if (!detail) return '';
  return wrapUntrusted(detail, ERROR_DETAIL_SOURCE)!;
}

/** Prefix + enveloped detail, or the prefix alone when detail is empty. */
export function formatApiErrorMessage(prefix: string, detail: string): string {
  if (!detail) return prefix;
  return `${prefix}: ${envelopeApiErrorDetail(detail)}`;
}
