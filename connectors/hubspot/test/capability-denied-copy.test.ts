import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

function expectHonestCapabilityDeniedCopy(parsed: {
  error: string;
  suggestion: string;
}, capabilityLabel = 'support tickets (Service Hub)'): void {
  // Host-neutral: the connector must not name the host app (no "Rebel"); the
  // brand subject was dropped so the error reads "Can't access <label> ...".
  expect(parsed.error).toContain(`Can't access ${capabilityLabel}`);
  expect(parsed.error).not.toContain('Rebel');
  expect(parsed.suggestion).toContain(capabilityLabel);
  expect(parsed.suggestion).toContain("reconnecting won't add it");
  expect(parsed.suggestion).toContain('HubSpot administrator');
  expect(parsed.suggestion).toContain("account's plan may not include it");
  expect(parsed.suggestion).toContain('Other HubSpot features are unaffected');
  expect(parsed.suggestion).not.toContain('grant the required scopes');
  expect(parsed.suggestion).not.toContain('Reconnect HubSpot and grant');
  expect(parsed.suggestion).not.toContain('Reconnect with full access');
}

async function parseStructuredThrownError(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return JSON.parse((error as Error).message) as Record<string, unknown>;
  }

  throw new Error('Expected structured HubSpot error');
}

describe('HubSpot capability-denied copy', () => {
  it('keeps the shared parser code and returns honest non-reconnect copy for ticket properties', async () => {
    const { HubSpotApiError } = await import('../src/api/hubspot-client.js');
    const { parseHubSpotError } = await import('../src/utils/error-parser.js');

    const parsed = parseHubSpotError(
      new HubSpotApiError('Forbidden', 403, {
        category: 'MISSING_SCOPES',
        message: 'Forbidden',
      }),
      { objectType: 'tickets', operation: 'list_properties' },
    );

    expect('status' in parsed).toBe(false);
    expect(parsed.errorCode).toBe('SCOPE_MISSING');
    expectHonestCapabilityDeniedCopy(parsed);
    expect(parsed.suggestion).toContain('support tickets require Service Hub, for example');
  });

  it('keeps the CRM wrapper code and returns honest non-reconnect copy for ticket search', async () => {
    class MockHubSpotApiError extends Error {
      constructor(
        message: string,
        public readonly statusCode: number,
        public readonly details?: unknown,
      ) {
        super(message);
        this.name = 'HubSpotApiError';
      }
    }

    const client = {
      searchObjects: vi.fn(async () => {
        throw new MockHubSpotApiError('Forbidden', 403, {
          category: 'MISSING_SCOPES',
          message: 'Forbidden',
        });
      }),
    };

    vi.doMock('../src/api/hubspot-client.js', () => ({
      getHubSpotClientAsync: vi.fn(async () => client),
      HubSpotApiError: MockHubSpotApiError,
      HubSpotAuthRequiredError: class HubSpotAuthRequiredError extends Error {},
    }));

    const { handleSearchTickets } = await import('../src/tools/crm-handlers.js');
    const parsed = await parseStructuredThrownError(handleSearchTickets({ query: 'printer', limit: 5 }));

    expect(parsed.errorCode).toBe('PERMISSION_DENIED');
    expectHonestCapabilityDeniedCopy(parsed as { error: string; suggestion: string });
    expect(parsed.suggestion).toContain('support tickets require Service Hub, for example');
  });

  it('keeps the file wrapper code and returns honest non-reconnect copy for file access', async () => {
    class MockHubSpotApiError extends Error {
      constructor(
        message: string,
        public readonly statusCode: number,
        public readonly details?: unknown,
      ) {
        super(message);
        this.name = 'HubSpotApiError';
      }
    }

    const client = {
      getFile: vi.fn(async () => {
        throw new MockHubSpotApiError('Forbidden', 403, {
          category: 'MISSING_SCOPES',
          message: 'Forbidden',
        });
      }),
    };

    vi.doMock('../src/api/hubspot-client.js', () => ({
      getHubSpotClientAsync: vi.fn(async () => client),
      HubSpotApiError: MockHubSpotApiError,
      HubSpotAuthRequiredError: class HubSpotAuthRequiredError extends Error {},
    }));

    const { handleGetFile } = await import('../src/tools/file-handlers.js');
    const parsed = await parseStructuredThrownError(handleGetFile({ fileId: '123' }));

    expect(parsed.errorCode).toBe('PERMISSION_DENIED');
    expectHonestCapabilityDeniedCopy(parsed as { error: string; suggestion: string }, 'files and attachments');
    expect(parsed.suggestion).toContain("account's plan may not include it. Other HubSpot features are unaffected");
    expect(parsed.suggestion).not.toContain('support tickets require Service Hub');
  });

  it('describes known and unknown HubSpot capabilities', async () => {
    const { describeHubSpotCapability } = await import('../src/utils/error-parser.js');

    expect(describeHubSpotCapability({ objectType: 'tickets', operation: 'search' })).toContain('tickets');
    expect(describeHubSpotCapability({ objectType: 'files', operation: 'upload_file' })).toBe('files and attachments');
    expect(describeHubSpotCapability({ objectType: 'emails', operation: 'search' })).toBe('emails');
    expect(describeHubSpotCapability({ objectType: 'custom_widgets', operation: 'search' })).toBe('this HubSpot capability');
  });
});
