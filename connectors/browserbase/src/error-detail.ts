/**
 * Envelope Browserbase API error `message` strings before they reach
 * model-visible tool error output (AGENTS.md security invariant #6).
 * Browserbase's Fastify error bodies (`{statusCode, error, message}`) are
 * third-party-authored text; interpolated raw into a ConnectorError they
 * would reach the model unenveloped. The structured code/resolution contract
 * is preserved — only the free-text detail is wrapped.
 */
import { wrapUntrusted } from './untrusted-content.js';

const ERROR_DETAIL_SOURCE = 'browserbase:error';

export function envelopeApiErrorDetail(detail: string): string {
  if (!detail) return '';
  return wrapUntrusted(detail, ERROR_DETAIL_SOURCE)!;
}
