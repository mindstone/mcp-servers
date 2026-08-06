/**
 * Direct unit tests for the REST client's abort/timeout behaviour.
 */

import { describe, it, expect } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './helpers/mock-auth.js';
import { mswServer } from './helpers/setup.js';
import { googleApi, Bases } from '../src/client.js';

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-adc.json',
);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('googleApi abort handling', () => {
  it('still enforces the request timeout when an external signal is supplied', async () => {
    mswServer.use(
      http.get(new RegExp(`^${escapeRegex(Bases.data)}/slow$`), async () => {
        await delay(500);
        return HttpResponse.json({});
      }),
    );
    const external = new AbortController();
    await expect(
      googleApi('/slow', { baseUrl: Bases.data, signal: external.signal, timeoutMs: 50 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('forwards an external abort into the in-flight request', async () => {
    mswServer.use(
      http.get(new RegExp(`^${escapeRegex(Bases.data)}/slow$`), async () => {
        await delay(5_000);
        return HttpResponse.json({});
      }),
    );
    const external = new AbortController();
    const pending = googleApi('/slow', {
      baseUrl: Bases.data,
      signal: external.signal,
      timeoutMs: 30_000,
    });
    setTimeout(() => external.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('honours an already-aborted external signal', async () => {
    mswServer.use(
      http.get(new RegExp(`^${escapeRegex(Bases.data)}/slow$`), () => HttpResponse.json({})),
    );
    const external = new AbortController();
    external.abort();
    await expect(
      googleApi('/slow', { baseUrl: Bases.data, signal: external.signal, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
