import axios from "axios";

import { XERO_CUSTOM_CONNECTION_SCOPES } from "../clients/xero-scopes.js";

export function isInvalidScopeError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const data: unknown = error.response?.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).error === "invalid_scope"
  );
}

/**
 * Xero's invalid_scope reply does not say which scope is missing, so ask for
 * each scope on its own. Returns null when a probe fails for any other reason
 * (network, rate limit, the deadline), so the caller falls back to the full list.
 */
const PROBE_DEADLINE_MS = 20_000;

export async function findMissingScopes(
  requestToken: (scope: string, signal: AbortSignal) => Promise<unknown>,
): Promise<string[] | null> {
  // One deadline for all probes, so a stalled request cannot hold back the error.
  const signal = AbortSignal.timeout(PROBE_DEADLINE_MS);
  const missing: string[] = [];
  for (const scope of XERO_CUSTOM_CONNECTION_SCOPES) {
    try {
      await requestToken(scope, signal);
    } catch (error) {
      if (!isInvalidScopeError(error)) return null;
      missing.push(scope);
    }
  }
  return missing;
}
