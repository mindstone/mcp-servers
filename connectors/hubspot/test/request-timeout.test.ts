import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeHubSpotRequestSignal,
  DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS,
  HubSpotClient,
  resolveHubSpotRequestTimeoutMs,
} from '../src/api/hubspot-client.js';
import { parseHubSpotError } from '../src/utils/error-parser.js';

describe('HubSpot request timeout configuration', () => {
  it('uses a 60s default when HUBSPOT_REQUEST_TIMEOUT_MS is unset', () => {
    expect(resolveHubSpotRequestTimeoutMs(undefined)).toBe(DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS);
  });

  it('applies a valid HUBSPOT_REQUEST_TIMEOUT_MS override', () => {
    expect(resolveHubSpotRequestTimeoutMs('45000')).toBe(45_000);
  });

  it('rejects HUBSPOT_REQUEST_TIMEOUT_MS values above 5 minutes with explicit error', () => {
    expect(() => resolveHubSpotRequestTimeoutMs('300001')).toThrow(
      'Must be less than or equal to 300000 (5 minutes).'
    );
  });

  it('composes caller AbortSignal with built-in timeout using AbortSignal.any()', () => {
    const controller = new AbortController();
    const signal = composeHubSpotRequestSignal(controller.signal, '60000');

    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe('HubSpot file upload deadline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** A fetch that never answers and settles only when its signal aborts. */
  function stubPendingFetch(): Array<AbortSignal | undefined> {
    const signals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }));
    return signals;
  }

  const upload = (signal?: AbortSignal) =>
    new HubSpotClient('test-token').uploadFile(Buffer.from('hello'), 'hello.txt', { access: 'PRIVATE', signal });

  it('aborts an upload when the shared request deadline expires', async () => {
    vi.stubEnv('HUBSPOT_REQUEST_TIMEOUT_MS', '40');
    const signals = stubPendingFetch();

    const startedAt = Date.now();
    const error = await upload().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(parseHubSpotError(error, { operation: 'upload_file' })).toMatchObject({ errorCode: 'REQUEST_TIMEOUT' });
  });

  it('aborts an upload when the caller cancels before the deadline', async () => {
    vi.stubEnv('HUBSPOT_REQUEST_TIMEOUT_MS', '60000');
    stubPendingFetch();
    const controller = new AbortController();

    const pending = upload(controller.signal).catch((caught: unknown) => caught);
    controller.abort();
    const error = await pending;

    expect(error).toMatchObject({ name: 'AbortError' });
    expect(parseHubSpotError(error, { operation: 'upload_file' })).toMatchObject({ errorCode: 'REQUEST_TIMEOUT' });
  });
});
