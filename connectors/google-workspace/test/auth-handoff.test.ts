import { describe, expect, it } from 'vitest';
import { toMcpError } from '../src/utils/apiError.js';
import { GSuiteServer } from '../src/tools/server.js';
import { AccountError } from '../src/modules/accounts/types.js';
import { CalendarError } from '../src/modules/calendar/types.js';

/**
 * Regression coverage for the mid-action auth-expiry handoff.
 *
 * The bug: a Gmail/Calendar/Contacts handler catches an auth error and calls
 * `toMcpError`, which used to wrap it into `McpError(InternalError, …)`. The
 * server's `formatErrorResponse` keys the structured `auth_required` reconnect
 * handoff on the raw domain error's string `code`, so after the wrap it saw an
 * McpError, skipped the auth branch, and degraded an expired-token failure to a
 * generic "Failed to …" message — the user never got the reconnect prompt.
 *
 * The fix has two parts, both exercised here through the real handler→server
 * path (`formatErrorResponse(toMcpError(...))`):
 *  1. `toMcpError` passes auth-handoff domain errors through unchanged.
 *  2. `formatErrorResponse` reads the string `code` from any domain error, not
 *     only `AccountError` — so a `CalendarError('AUTH_REQUIRED')` from
 *     `getCalendarClient` also triggers the handoff.
 */

// Constructor is env-independent; cast to reach the private formatErrorResponse.
const formatErrorResponse = (error: unknown): Record<string, unknown> =>
  (new GSuiteServer() as unknown as {
    formatErrorResponse(error: unknown): Record<string, unknown>;
  }).formatErrorResponse(error);

const AUTH_REQUIRED_HANDOFF = {
  status: 'auth_required',
  user_action: { id: 'google.connect_account' },
  setupToolName: 'authenticate_workspace_account',
};

describe('auth-handoff surfacing through toMcpError → formatErrorResponse', () => {
  it('Account(AUTH_REQUIRED) from token renewal still triggers the reconnect handoff after toMcpError', () => {
    const thrown = toMcpError(
      new AccountError('Authentication required', 'AUTH_REQUIRED', 'Connect Google Workspace to continue'),
      'Failed to create calendar event',
    );
    expect(formatErrorResponse(thrown)).toMatchObject(AUTH_REQUIRED_HANDOFF);
  });

  it('CalendarError(AUTH_REQUIRED) from getCalendarClient triggers the handoff (previously AccountError-only)', () => {
    const thrown = toMcpError(
      new CalendarError('Calendar authentication required', 'AUTH_REQUIRED', 'Please authenticate to access calendar'),
      'Failed to create calendar event',
    );
    expect(formatErrorResponse(thrown)).toMatchObject(AUTH_REQUIRED_HANDOFF);
  });

  it('does NOT trigger the handoff for a non-auth operational failure (no false positive)', () => {
    const thrown = toMcpError(
      new CalendarError('Insufficient permissions', 'PERMISSION_DENIED', 'The caller does not have permission'),
      'Failed to create calendar event',
    );
    const response = formatErrorResponse(thrown);
    expect(response.status).not.toBe('auth_required');
    expect(response.ok).toBe(false);
    // The real cause is still folded into the surfaced message (opacity-sweep behaviour).
    expect(String(response.action_required)).toContain('Insufficient permissions');
  });
});
