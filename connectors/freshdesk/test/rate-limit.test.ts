import { describe, it, expect } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { mswServer } from './helpers/setup.js';
import { freshdeskFetch } from '../src/client.js';
import { FreshdeskError } from '../src/types.js';

const BASE = 'https://testacme.freshdesk.com/api/v2';
const API_KEY = 'mock-test-key';

describe('freshdeskFetch rate-limit handling', () => {
  it('retries GET requests on 429 and succeeds after Retry-After', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get(`${BASE}/tickets/1`, () => {
        requestCount++;
        if (requestCount === 1) {
          return HttpResponse.json(
            { message: 'Rate limit exceeded' },
            { status: 429, headers: { 'Retry-After': '0' } },
          );
        }
        return HttpResponse.json({ id: 1, subject: 'After retry' });
      }),
    );

    const result = await freshdeskFetch<{ id: number; subject: string }>(
      'testacme',
      API_KEY,
      '/tickets/1',
    );

    expect(result.subject).toBe('After retry');
    expect(requestCount).toBe(2);
  });

  it('exhausts GET retries on persistent 429 and throws RATE_LIMITED', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get(`${BASE}/tickets`, () => {
        requestCount++;
        return HttpResponse.json(
          { message: 'Rate limit exceeded' },
          { status: 429, headers: { 'Retry-After': '0' } },
        );
      }),
    );

    try {
      await freshdeskFetch('testacme', API_KEY, '/tickets');
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FreshdeskError);
      expect((error as FreshdeskError).code).toBe('RATE_LIMITED');
    }
    // 1 initial request + 2 retries
    expect(requestCount).toBe(3);
  });

  it('does not retry POST requests on 429 (writes are not idempotent)', async () => {
    let requestCount = 0;
    mswServer.use(
      http.post(`${BASE}/tickets`, () => {
        requestCount++;
        return HttpResponse.json(
          { message: 'Rate limit exceeded' },
          { status: 429, headers: { 'Retry-After': '60' } },
        );
      }),
    );

    try {
      await freshdeskFetch('testacme', API_KEY, '/tickets', {
        method: 'POST',
        body: JSON.stringify({ email: 'a@b.com', subject: 's', description: 'd' }),
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FreshdeskError);
      const fdError = error as FreshdeskError;
      expect(fdError.code).toBe('RATE_LIMITED');
      expect(fdError.message).toContain('60 seconds');
    }
    expect(requestCount).toBe(1);
  });

  it('honours Retry-After capping so pathological values cannot stall the process', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get(`${BASE}/tickets/1`, () => {
        requestCount++;
        if (requestCount === 1) {
          return HttpResponse.json(
            { message: 'Rate limit exceeded' },
            // A hostile/absurd Retry-After must be capped (at 30s), not honoured verbatim.
            { status: 429, headers: { 'Retry-After': '3600' } },
          );
        }
        return HttpResponse.json({ id: 1, subject: 'After retry' });
      }),
    );

    // Fake timers fast-forward through the capped wait; the test completing
    // at all proves the 3600s header was not honoured verbatim.
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const promise = freshdeskFetch<{ id: number }>('testacme', API_KEY, '/tickets/1');
      await vi.advanceTimersByTimeAsync(30_500);
      const result = await promise;
      expect(result.id).toBe(1);
      expect(requestCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a backoff that would exceed the shared wall-clock retry budget', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get(`${BASE}/tickets`, async () => {
        requestCount++;
        // The first (and only) response consumes most of the 90s shared
        // budget, so a 30s backoff can no longer fit inside it — the loop
        // must surface RATE_LIMITED instead of sleeping and retrying.
        await delay(80_000);
        return HttpResponse.json(
          { message: 'Rate limit exceeded' },
          { status: 429, headers: { 'Retry-After': '30' } },
        );
      }),
    );

    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const promise = freshdeskFetch('testacme', API_KEY, '/tickets');
      const assertion = expect(promise).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      await vi.advanceTimersByTimeAsync(95_000);
      await assertion;
      // No retry was attempted: the backoff would have overrun the budget.
      expect(requestCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
