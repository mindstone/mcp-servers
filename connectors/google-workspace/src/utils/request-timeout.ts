import { google } from 'googleapis';
import logger from './logger.js';

export const DEFAULT_GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS = 60_000;
const MAX_GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS = 5 * 60_000;

export function resolveRequestTimeoutMs(): number {
  const raw = process.env.GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS) {
    logger.warn({ raw }, 'GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS invalid; using default');
    return DEFAULT_GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS;
  }
  return parsed;
}

export function composeAbortSignal(caller?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(resolveRequestTimeoutMs());
  if (!caller) return timeoutSignal;
  return AbortSignal.any([caller, timeoutSignal]);
}

export function applyDefaultGoogleRequestOptions(): void {
  google.options({
    timeout: resolveRequestTimeoutMs(),
  });
}
