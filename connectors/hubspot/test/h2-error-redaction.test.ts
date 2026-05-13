import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubSpotApiError, HubSpotClient } from '../src/api/hubspot-client.js';
import {
  parseHubSpotError,
  summariseHubSpotApiError,
  type HubSpotApiErrorSummary,
} from '../src/utils/error-parser.js';

const RAW_PII_MARKERS = [
  'jane.customer@example.com',
  'pat-na1-sensitive-token-fragment',
  '1234567890',
  'Customer note: please call my private mobile',
  'raw-validation-message',
];

const SUMMARY_KEYS = ['operation', 'statusCode', 'errorCode', 'category', 'requestId', 'retryAfterSeconds'];

function expectNoRawPii(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const marker of RAW_PII_MARKERS) {
    expect(serialized).not.toContain(marker);
  }
}

function expectOnlySummaryKeys(summary: HubSpotApiErrorSummary): void {
  expect(Object.keys(summary).sort()).toEqual(
    expect.arrayContaining(Object.keys(summary).filter((key) => SUMMARY_KEYS.includes(key))),
  );
  for (const key of Object.keys(summary)) {
    expect(SUMMARY_KEYS).toContain(key);
  }
}

function createRawHubSpotBody(category: string, code: string): Record<string, unknown> {
  return {
    message: `Property values were not valid; raw-validation-message for jane.customer@example.com with Customer note: please call my private mobile`,
    category,
    errorCode: code,
    portalId: 1234567890,
    trace: 'oauth=pat-na1-sensitive-token-fragment',
    correlationId: 'corr-safe-abc-123',
    errors: [
      {
        message: 'raw-validation-message jane.customer@example.com',
        context: {
          propertyName: ['email'],
          value: ['jane.customer@example.com'],
          type: ['string'],
        },
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('H2 HubSpot API error redaction', () => {
  it('summarises HubSpot API errors with only whitelisted keys', () => {
    const rawBody = createRawHubSpotBody('VALIDATION_ERROR', 'VALIDATION_ERROR');
    const summary = summariseHubSpotApiError(
      new HubSpotApiError('raw failure jane.customer@example.com', 400, rawBody, 'header-request-123'),
      { operation: 'create' },
    );

    expect(summary).toEqual({
      operation: 'create',
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      category: 'VALIDATION_ERROR',
      requestId: 'header-request-123',
    });
    expectOnlySummaryKeys(summary);
    expectNoRawPii(summary);
  });

  it('keeps only property names for property validation errors', () => {
    const parsed = parseHubSpotError(
      new HubSpotApiError(
        'HubSpot API error: 400 Bad Request',
        400,
        createRawHubSpotBody('VALIDATION_ERROR', 'VALIDATION_ERROR'),
        'validation-request-123',
      ),
      { objectType: 'contacts', operation: 'create' },
    );

    expect('status' in parsed).toBe(false);
    if ('status' in parsed) return;
    expect(parsed.errorCode).toBe('VALIDATION_ERROR');
    expect(parsed.invalidProperties).toEqual(['email']);
    expect(parsed.details).toBeDefined();
    expectOnlySummaryKeys(parsed.details!);
    expectNoRawPii(parsed);
  });

  it('extracts top-level propertyName values and excludes invalidValue/message payloads', () => {
    const parsed = parseHubSpotError(
      new HubSpotApiError(
        'HubSpot API error: 400 Bad Request',
        400,
        {
          message: 'Property values were not valid',
          category: 'VALIDATION_ERROR',
          errorCode: 'VALIDATION_ERROR',
          errors: [
            {
              propertyName: 'email',
              invalidValue: 'jane.customer@example.com',
              message: 'raw-validation-message',
            },
          ],
        },
        'validation-request-456',
      ),
      { objectType: 'contacts', operation: 'create' },
    );

    expect('status' in parsed).toBe(false);
    if ('status' in parsed) return;
    expect(parsed.errorCode).toBe('VALIDATION_ERROR');
    expect(parsed.invalidProperties).toEqual(['email']);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('invalidValue');
    expect(serialized).not.toContain('raw-validation-message');
    expectNoRawPii(parsed);
  });

  it('includes retryAfterSeconds in RATE_LIMITED summary for numeric Retry-After headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: 'slow down',
      category: 'RATE_LIMIT',
      errorCode: 'RATE_LIMIT_ERROR',
    }), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: {
        'content-type': 'application/json',
        'Retry-After': '30',
        'x-hubspot-correlation-id': 'rate-request-123',
      },
    })));

    const client = new HubSpotClient('access-token');
    let caught: unknown;
    try {
      await client.getObject('contacts', '123');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HubSpotApiError);
    const parsed = parseHubSpotError(caught, { objectType: 'contacts', operation: 'get' });
    expect('status' in parsed).toBe(false);
    if ('status' in parsed) return;
    expect(parsed.errorCode).toBe('RATE_LIMITED');
    expect(parsed.details).toMatchObject({ retryAfterSeconds: 30 });
    expectOnlySummaryKeys(parsed.details!);
  });

  it('parses HTTP-date Retry-After headers into retryAfterSeconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00.000Z'));
    const retryAt = new Date(Date.now() + 45_000).toUTCString();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: 'slow down',
      category: 'RATE_LIMIT',
      errorCode: 'RATE_LIMIT_ERROR',
    }), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: {
        'content-type': 'application/json',
        'retry-after': retryAt,
        'x-hubspot-correlation-id': 'rate-request-456',
      },
    })));

    const client = new HubSpotClient('access-token');
    let caught: unknown;
    try {
      await client.getObject('contacts', '456');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HubSpotApiError);
    const parsed = parseHubSpotError(caught, { objectType: 'contacts', operation: 'get' });
    expect('status' in parsed).toBe(false);
    if ('status' in parsed) return;
    expect(parsed.errorCode).toBe('RATE_LIMITED');
    expect(parsed.details?.retryAfterSeconds).toBe(45);
  });

  it.each([
    ['AUTH_ERROR', new HubSpotApiError('auth raw jane.customer@example.com', 401, createRawHubSpotBody('AUTHENTICATION_ERROR', 'AUTH_ERROR'), 'auth-request-123')],
    ['RATE_LIMIT_ERROR', new HubSpotApiError('rate raw jane.customer@example.com', 429, createRawHubSpotBody('RATE_LIMIT', 'RATE_LIMIT_ERROR'), 'rate-request-123')],
    ['API_ERROR', new HubSpotApiError('api raw jane.customer@example.com', 500, createRawHubSpotBody('SERVER_ERROR', 'API_ERROR'), 'api-request-123')],
    ['UNKNOWN_ERROR', new Error('Customer note: please call my private mobile jane.customer@example.com pat-na1-sensitive-token-fragment')],
  ])('does not echo raw PII for %s responses', (_caseName, error) => {
    const parsed = parseHubSpotError(error, { objectType: 'contacts', operation: 'search' });

    expectNoRawPii(parsed);
    if (!('status' in parsed) && parsed.details) {
      expectOnlySummaryKeys(parsed.details);
      expectNoRawPii(parsed.details);
    }
  });

  it('drops unsafe error-code values instead of echoing them', () => {
    const summary = summariseHubSpotApiError({
      statusCode: 400,
      details: {
        errorCode: 'jane.customer@example.com',
        category: 'VALIDATION_ERROR',
        requestId: 'safe-request-id',
        message: 'Customer note: please call my private mobile',
      },
    }, { operation: 'update' });

    expect(summary).toEqual({
      operation: 'update',
      statusCode: 400,
      category: 'VALIDATION_ERROR',
      requestId: 'safe-request-id',
    });
    expectNoRawPii(summary);
  });

  it('maps AbortError to REQUEST_TIMEOUT', () => {
    const abortError = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const parsed = parseHubSpotError(abortError, { objectType: 'contacts', operation: 'search' });

    expect('status' in parsed).toBe(false);
    if ('status' in parsed) return;
    expect(parsed.errorCode).toBe('REQUEST_TIMEOUT');
    expect(parsed.suggestion).toContain('Retry');
  });

  it('maps ENOTFOUND errors to NETWORK_ERROR', () => {
    const networkError = Object.assign(new Error('getaddrinfo ENOTFOUND api.hubapi.com'), { code: 'ENOTFOUND' });
    const parsed = parseHubSpotError(networkError, { objectType: 'contacts', operation: 'search' });

    expect('status' in parsed).toBe(false);
    if ('status' in parsed) return;
    expect(parsed.errorCode).toBe('NETWORK_ERROR');
  });

  it('keeps unknown random errors mapped to UNKNOWN_ERROR', () => {
    const parsed = parseHubSpotError(new Error('totally random runtime issue'), {
      objectType: 'contacts',
      operation: 'search',
    });

    expect('status' in parsed).toBe(false);
    if ('status' in parsed) return;
    expect(parsed.errorCode).toBe('UNKNOWN_ERROR');
  });
});
