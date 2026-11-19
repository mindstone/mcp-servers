import { describe, expect, it } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  describeApiError,
  extractHttpStatus,
  failedResult,
  hasErrorDetails,
  isAuthHandoffError,
  operationFailure,
  toMcpError,
  withCause,
} from '../src/utils/apiError.js';
import { GmailError } from '../src/modules/gmail/types.js';
import { BaseGoogleService, GoogleServiceError } from '../src/services/base/BaseGoogleService.js';

describe('extractHttpStatus', () => {
  it('prefers response.status', () => {
    expect(extractHttpStatus({ response: { status: 404 }, code: 500 })).toBe(404);
  });

  it('falls back to a top-level status', () => {
    expect(extractHttpStatus(Object.assign(new Error('x'), { status: 400 }))).toBe(400);
  });

  it('falls back to a numeric code', () => {
    expect(extractHttpStatus(Object.assign(new Error('x'), { code: 500 }))).toBe(500);
  });

  it('coerces a numeric-string code', () => {
    expect(extractHttpStatus(Object.assign(new Error('x'), { code: '409' }))).toBe(409);
  });

  it('ignores a non-numeric string code (ENOTFOUND)', () => {
    expect(extractHttpStatus(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBeUndefined();
  });

  it('ignores protocol error codes that are outside the HTTP range', () => {
    expect(extractHttpStatus(Object.assign(new Error('x'), { code: -32603 }))).toBeUndefined();
  });

  it('returns undefined for non-objects', () => {
    expect(extractHttpStatus('boom')).toBeUndefined();
    expect(extractHttpStatus(null)).toBeUndefined();
  });
});

describe('describeApiError', () => {
  it('appends the HTTP status when available', () => {
    const err = Object.assign(new Error('Requested entity was not found.'), {
      response: { status: 404 },
    });
    expect(describeApiError(err)).toBe('Requested entity was not found. (status 404)');
  });

  it('keeps the plain message when no status is present', () => {
    expect(describeApiError(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('returns "Unknown error" for a non-Error throw', () => {
    expect(describeApiError('boom')).toBe('Unknown error');
  });
});

describe('hasErrorDetails', () => {
  it('recognizes a domain error shape with string details', () => {
    expect(hasErrorDetails({ message: 'm', code: 'C', details: 'd' })).toBe(true);
  });

  it('rejects a plain Error (no details)', () => {
    expect(hasErrorDetails(new Error('m'))).toBe(false);
  });

  it('rejects when details is not a string', () => {
    expect(hasErrorDetails({ message: 'm', code: 'C', details: 123 })).toBe(false);
  });

  it('rejects when code is missing (message + details only)', () => {
    expect(hasErrorDetails({ message: 'm', details: 'd' })).toBe(false);
  });

  it('rejects a transport-error shape with a numeric code (not a domain error)', () => {
    expect(hasErrorDetails({ message: 'Boom', code: 500, details: 'quota exceeded' })).toBe(false);
  });
});

describe('toMcpError', () => {
  it('passes an existing McpError through unchanged', () => {
    const original = new McpError(ErrorCode.InvalidParams, 'Draft ID required');
    expect(toMcpError(original, 'Failed to manage draft')).toBe(original);
  });

  it('surfaces a domain error message and details', () => {
    const domain = { message: 'Failed to update draft', code: 'UPDATE_ERROR', details: 'Requested entity was not found. (status 404)' };
    const mcp = toMcpError(domain, 'Failed to manage draft');
    expect(mcp).toBeInstanceOf(McpError);
    expect((mcp as McpError).code).toBe(ErrorCode.InternalError);
    expect(mcp.message).toContain(
      'Failed to manage draft: Failed to update draft: Requested entity was not found. (status 404)'
    );
  });

  it('describes a raw API error with its status', () => {
    const err = Object.assign(new Error('Rate limit exceeded'), { response: { status: 429 } });
    const mcp = toMcpError(err, 'Failed to list tasks');
    expect(mcp).toBe(err);
  });

  it('falls back to Unknown error for a non-Error throw with no details', () => {
    const mcp = toMcpError('boom', 'Failed to get form');
    expect(mcp.message).toContain('Failed to get form: Unknown error');
  });

  it('prefers describeApiError over a transport error that happens to carry string details', () => {
    // Numeric code => not a domain error; details must NOT be surfaced as a domain detail.
    // A real GaxiosError is an Error instance, so describeApiError reads its message.
    const transport = Object.assign(new Error('Boom'), { code: 500, details: 'internal quota state' });
    const mcp = toMcpError(transport, 'Failed to list tasks');
    expect(mcp.message).toContain('Failed to list tasks: Boom (status 500)');
    expect(mcp.message).not.toContain('internal quota state');
  });

  it('passes an auth-handoff domain error through UNCHANGED so the auth code survives', () => {
    // An expired-token AccountError/CalendarError must reach formatErrorResponse as itself, not
    // wrapped into McpError(InternalError) — otherwise the `auth_required` reconnect handoff
    // (keyed on the domain error's string `code`) is lost. Regression guard for the mid-action
    // auth-expiry bug.
    const authError = Object.assign(new Error('Authentication required'), {
      code: 'AUTH_REQUIRED',
      resolution: 'Reconnect your Google account',
    });
    const result = toMcpError(authError, 'Failed to create calendar event');
    expect(result).toBe(authError);
    expect(result).not.toBeInstanceOf(McpError);
    expect((result as { code: string }).code).toBe('AUTH_REQUIRED');
  });

  it('passes a HOST_ORCHESTRATED_AUTH_REQUIRED error through unchanged', () => {
    const authError = Object.assign(new Error('Sign-in needed'), { code: 'HOST_ORCHESTRATED_AUTH_REQUIRED' });
    expect(toMcpError(authError, 'Failed to send email')).toBe(authError);
  });

  it('still wraps a NON-auth domain error into McpError (no false pass-through)', () => {
    const permError = Object.assign(new Error('Insufficient permissions'), {
      code: 'PERMISSION_DENIED',
      details: 'The caller does not have permission',
    });
    const mcp = toMcpError(permError, 'Failed to create calendar event');
    expect(mcp).toBeInstanceOf(McpError);
    expect((mcp as McpError).code).toBe(ErrorCode.InternalError);
    expect(mcp.message).toContain('Failed to create calendar event: Insufficient permissions: The caller does not have permission');
  });

  it('does not pass a non-Error auth-shaped value through (must be a real Error to throw safely)', () => {
    // A plain object with an auth code is NOT passed through — toMcpError must always return a
    // throwable Error. It falls through to the describeApiError wrap instead.
    const mcp = toMcpError({ code: 'AUTH_REQUIRED', message: 'x' }, 'Failed to get contacts');
    expect(mcp).toBeInstanceOf(McpError);
  });
});

describe('isAuthHandoffError', () => {
  it('recognizes the two auth-handoff codes', () => {
    expect(isAuthHandoffError({ code: 'AUTH_REQUIRED' })).toBe(true);
    expect(isAuthHandoffError({ code: 'HOST_ORCHESTRATED_AUTH_REQUIRED' })).toBe(true);
  });

  it('rejects non-auth codes and non-string codes', () => {
    expect(isAuthHandoffError({ code: 'PERMISSION_DENIED' })).toBe(false);
    expect(isAuthHandoffError({ code: 401 })).toBe(false);
    expect(isAuthHandoffError({ message: 'no code' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isAuthHandoffError('AUTH_REQUIRED')).toBe(false);
    expect(isAuthHandoffError(null)).toBe(false);
    expect(isAuthHandoffError(undefined)).toBe(false);
  });
});

/** A Google 403 as googleapis throws it: the status lives on the transport error only. */
function google403(): Error {
  return Object.assign(new Error('Request had insufficient authentication scopes. File "Board pack"'), {
    response: { status: 403, data: { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } } },
  });
}

class ProbeService extends BaseGoogleService<unknown> {
  constructor() {
    super({ serviceName: 'probe', version: 'v1' });
  }

  wrap(error: unknown): Error {
    return this.handleError(error, 'Failed to probe');
  }
}

describe('withCause', () => {
  it('links the cause without making it enumerable', () => {
    const original = google403();
    const target = withCause({ success: false, error: 'Failed' }, original);

    expect(target.cause).toBe(original);
    expect(Object.keys(target)).toEqual(['success', 'error']);
    expect(JSON.stringify(target)).toBe('{"success":false,"error":"Failed"}');
    expect({ ...target }).not.toHaveProperty('cause');
  });

  it('never overwrites an existing cause', () => {
    const first = new Error('first');
    const target = new Error('wrapper', { cause: first });

    withCause(target, new Error('second'));

    expect(target.cause).toBe(first);
  });

  it('leaves the target untouched when there is no cause', () => {
    const target = withCause({ success: false, error: 'Failed' }, undefined);

    expect(Object.prototype.hasOwnProperty.call(target, 'cause')).toBe(false);
  });
});

describe('status survives the connector wrappers', () => {
  it('reads 403 through a GmailError built with a cause', () => {
    const wrapped = new GmailError('Failed to search emails', 'SEARCH_ERROR', 'Error: x', google403());

    expect(extractHttpStatus(wrapped)).toBe(403);
    expect(JSON.stringify(wrapped)).not.toContain('Board pack');
  });

  it('reads 403 through a GoogleServiceError from BaseGoogleService.handleError', () => {
    const wrapped = new ProbeService().wrap(google403());

    expect(wrapped).toBeInstanceOf(GoogleServiceError);
    expect(wrapped.message).toContain('Failed to probe');
    expect(extractHttpStatus(wrapped)).toBe(403);
    expect(Object.keys(wrapped)).not.toContain('cause');
  });

  it('reads 403 through a toMcpError wrapper', () => {
    const wrapped = toMcpError(google403(), 'Failed to list files');

    expect(wrapped).toBeInstanceOf(McpError);
    expect(extractHttpStatus(wrapped)).toBe(403);
  });

  it('reads 403 through operationFailure built from failedResult', () => {
    const result = failedResult(google403(), 'Request had insufficient authentication scopes. (status 403)');
    const wrapped = operationFailure(result, `Failed to read spreadsheet: ${result.error}`);

    expect(wrapped).toBeInstanceOf(McpError);
    expect(wrapped.code).toBe(ErrorCode.InternalError);
    expect(extractHttpStatus(wrapped)).toBe(403);
    expect(JSON.stringify(result)).not.toContain('cause');
  });
});
