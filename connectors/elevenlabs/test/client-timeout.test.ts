import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { elevenLabsJson } from '../src/client.js';
import { LONG_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../src/types.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

const BASE_V1 = 'https://api.elevenlabs.io/v1';

describe('client timeoutMs override (R2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses REQUEST_TIMEOUT_MS by default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mswServer.use(
      http.get(`${BASE_V1}/user/subscription`, () => HttpResponse.json({ tier: 'starter' })),
    );

    await elevenLabsJson(MOCK_API_KEY, '/user/subscription');

    expect(timeoutSpy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
  });

  it('honours per-call timeoutMs override for slow endpoints', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mswServer.use(
      http.post(`${BASE_V1}/text-to-dialogue`, () =>
        HttpResponse.json({ previews: [] }),
      ),
    );

    await elevenLabsJson(
      MOCK_API_KEY,
      '/text-to-dialogue',
      { method: 'POST', body: '{}', timeoutMs: LONG_REQUEST_TIMEOUT_MS },
    );

    expect(timeoutSpy).toHaveBeenCalledWith(LONG_REQUEST_TIMEOUT_MS);
  });

  it('prefers an explicit signal over timeoutMs', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const controller = new AbortController();
    mswServer.use(
      http.get(`${BASE_V1}/user/subscription`, () => HttpResponse.json({ tier: 'starter' })),
    );

    await elevenLabsJson(MOCK_API_KEY, '/user/subscription', {
      signal: controller.signal,
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    });

    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('reports a response body read abort as TIMEOUT, not as a non-JSON body', async () => {
    // A mid-stream abort/timeout rejects response.json() too; mislabelling it
    // as "the API response format may have changed" sends the caller down the
    // wrong remediation path for a transient network fault.
    mswServer.use(
      http.get(
        `${BASE_V1}/user/subscription`,
        () =>
          new HttpResponse(
            new ReadableStream({
              start(streamController) {
                streamController.enqueue(new TextEncoder().encode('{"tier":"sta'));
                streamController.error(new DOMException('The operation timed out', 'TimeoutError'));
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    await expect(elevenLabsJson(MOCK_API_KEY, '/user/subscription')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('still reports a genuine non-JSON 200 body as INVALID_RESPONSE', async () => {
    mswServer.use(
      http.get(
        `${BASE_V1}/user/subscription`,
        () =>
          new HttpResponse('<html>not json</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    await expect(elevenLabsJson(MOCK_API_KEY, '/user/subscription')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});
