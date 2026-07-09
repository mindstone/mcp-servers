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
  // Honest, multi-cause: names all three causes and states reconnecting alone
  // won't fix it — but keeps reconnect as the final step once the cause is resolved.
  expect(parsed.suggestion).toContain("reconnecting won't add it on its own");
  expect(parsed.suggestion).toContain('HubSpot administrator');
  expect(parsed.suggestion).toContain("account's plan may not include it");
  expect(parsed.suggestion).toContain('may not have permission for it');
  expect(parsed.suggestion).toContain('reconnect HubSpot to pick up the change');
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
    // Files map to a scope, not a paid hub — no plan-specific example in the copy.
    expect(parsed.suggestion).not.toContain('support tickets require Service Hub');
    expect(parsed.suggestion).not.toContain('for example');
  });

  it('returns honest multi-cause copy for a marketing-email 403 (the Arthur / FOX-3631 case)', async () => {
    const { HubSpotApiError } = await import('../src/api/hubspot-client.js');
    const { parseHubSpotError } = await import('../src/utils/error-parser.js');

    const parsed = parseHubSpotError(
      new HubSpotApiError('Forbidden', 403, {
        category: 'MISSING_SCOPES',
        message: 'Forbidden',
        context: { requiredGranularScopes: ['content'] },
      }),
      { objectType: 'marketing_emails', operation: 'get' },
    );

    expect('status' in parsed).toBe(false);
    expect(parsed.errorCode).toBe('SCOPE_MISSING');
    expectHonestCapabilityDeniedCopy(
      parsed as { error: string; suggestion: string },
      'marketing emails (Marketing Hub)',
    );
    expect(parsed.suggestion).toContain('marketing emails require a paid Marketing Hub plan, for example');
    // The single-cause message Arthur hit must be gone.
    expect((parsed as { suggestion: string }).suggestion).not.toContain('requires a Marketing Hub subscription');
    // Diagnostic: the scope HubSpot named is surfaced for telemetry, not guessed.
    const details = (parsed as { details?: { requiredScopes?: string[]; category?: string } }).details;
    expect(details?.requiredScopes).toEqual(['content']);
    expect(details?.category).toBe('MISSING_SCOPES');
  });

  it('returns honest multi-cause copy for a workflow 403 and surfaces v4 context scopes', async () => {
    const { HubSpotApiError } = await import('../src/api/hubspot-client.js');
    const { parseHubSpotError } = await import('../src/utils/error-parser.js');

    const parsed = parseHubSpotError(
      new HubSpotApiError('Forbidden', 403, {
        category: 'MISSING_SCOPES',
        message: 'Forbidden',
        context: { requiredScopes: ['automation'] },
      }),
      { objectType: 'workflows', operation: 'list' },
    );

    expect(parsed.errorCode).toBe('SCOPE_MISSING');
    expectHonestCapabilityDeniedCopy(
      parsed as { error: string; suggestion: string },
      'workflows and automation',
    );
    const details = (parsed as { details?: { requiredScopes?: string[] } }).details;
    expect(details?.requiredScopes).toEqual(['automation']);
  });

  it('omits requiredScopes when HubSpot names none, and never fabricates one', async () => {
    const { HubSpotApiError } = await import('../src/api/hubspot-client.js');
    const { parseHubSpotError } = await import('../src/utils/error-parser.js');

    const parsed = parseHubSpotError(
      new HubSpotApiError('Forbidden', 403, { category: 'MISSING_SCOPES', message: 'Forbidden' }),
      { objectType: 'analytics', operation: 'get' },
    );

    const details = (parsed as { details?: { requiredScopes?: string[] } }).details;
    expect(details?.requiredScopes).toBeUndefined();
  });

  it('routes handleGetMarketingEmail (feature "marketing_email") 403 to honest copy + scope diagnostics', async () => {
    // Regression guard: the content-read path uses the singular feature
    // "marketing_email"; it must hit the migrated honest-copy branch (not the
    // old reconnect-leaning generic SCOPE_OR_PERMISSION_DENIED fallthrough).
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
      getMarketingEmail: vi.fn(async () => {
        throw new MockHubSpotApiError('Forbidden', 403, {
          category: 'MISSING_SCOPES',
          message: 'Forbidden',
          context: { requiredGranularScopes: ['content'] },
        });
      }),
    };

    vi.doMock('../src/api/hubspot-client.js', () => ({
      getHubSpotClientAsync: vi.fn(async () => client),
      HubSpotApiError: MockHubSpotApiError,
      HubSpotAuthRequiredError: class HubSpotAuthRequiredError extends Error {},
    }));

    const { handleGetMarketingEmail } = await import('../src/tools/marketing-handlers.js');
    const parsed = await parseStructuredThrownError(handleGetMarketingEmail({ emailId: '356828319969' }));

    expect(parsed.errorCode).toBe('SCOPE_MISSING');
    expectHonestCapabilityDeniedCopy(
      parsed as { error: string; suggestion: string },
      'marketing emails (Marketing Hub)',
    );
    // Must NOT be the old circular copy.
    expect((parsed as { suggestion: string }).suggestion).not.toContain('reconnecting HubSpot to grant additional scopes');
    const details = (parsed as { details?: { requiredScopes?: string[] } }).details;
    expect(details?.requiredScopes).toEqual(['content']);
  });

  it('describes known and unknown HubSpot capabilities', async () => {
    const { describeHubSpotCapability } = await import('../src/utils/error-parser.js');

    expect(describeHubSpotCapability({ objectType: 'tickets', operation: 'search' })).toContain('tickets');
    expect(describeHubSpotCapability({ objectType: 'files', operation: 'upload_file' })).toBe('files and attachments');
    expect(describeHubSpotCapability({ objectType: 'emails', operation: 'search' })).toBe('emails');
    expect(describeHubSpotCapability({ objectType: 'marketing_emails', operation: 'get' })).toBe('marketing emails (Marketing Hub)');
    expect(describeHubSpotCapability({ objectType: 'workflows', operation: 'list' })).toBe('workflows and automation');
    expect(describeHubSpotCapability({ objectType: 'custom_widgets', operation: 'search' })).toBe('this HubSpot capability');
  });
});
