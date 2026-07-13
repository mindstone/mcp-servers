import { describe, expect, it } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  describeApiError,
  extractHttpStatus,
  hasErrorDetails,
  toMcpError,
} from '../src/utils/apiError.js';

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
    expect(mcp.code).toBe(ErrorCode.InternalError);
    expect(mcp.message).toContain(
      'Failed to manage draft: Failed to update draft: Requested entity was not found. (status 404)'
    );
  });

  it('describes a raw API error with its status', () => {
    const err = Object.assign(new Error('Rate limit exceeded'), { response: { status: 429 } });
    const mcp = toMcpError(err, 'Failed to list tasks');
    expect(mcp.message).toContain('Failed to list tasks: Rate limit exceeded (status 429)');
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
});
