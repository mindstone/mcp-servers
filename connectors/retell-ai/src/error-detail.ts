/**
 * Envelope Retell API error `detail` strings before they reach model-visible
 * tool error output (AGENTS.md security invariant #6). Retell's
 * `error_message` / `detail` / `message` fields are third-party-authored text;
 * interpolated raw into a ConnectorError they would reach the model
 * unenveloped. The structured code/resolution contract is preserved — only
 * the free-text detail is wrapped.
 */
import { wrapUntrusted } from './untrusted-content.js';

const ERROR_DETAIL_SOURCE = 'retell:error';

export function envelopeApiErrorDetail(detail: string): string {
  if (!detail) return '';
  return wrapUntrusted(detail, ERROR_DETAIL_SOURCE)!;
}
