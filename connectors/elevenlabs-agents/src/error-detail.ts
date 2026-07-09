/**
 * Envelope third-party API error `detail` strings before they reach model-visible
 * tool error output. FastAPI-422 flattening stays intact: we wrap the flattened
 * string rather than discarding the field-level detail the model needs.
 */
import { wrapUntrusted } from './untrusted-content.js';

const ERROR_DETAIL_SOURCE = 'elevenlabs-agents:api:error_detail';

export function envelopeApiErrorDetail(detail: string): string {
  if (!detail) return '';
  return wrapUntrusted(detail, ERROR_DETAIL_SOURCE)!;
}

export function formatApiErrorMessage(prefix: string, detail: string): string {
  if (!detail) return prefix;
  return `${prefix}: ${envelopeApiErrorDetail(detail)}`;
}
