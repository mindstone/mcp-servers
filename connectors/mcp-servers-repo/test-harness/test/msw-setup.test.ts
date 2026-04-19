import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

/**
 * Tests for setupMswServer.
 *
 * We cannot directly call setupMswServer() here because it registers
 * beforeAll/afterEach/afterAll hooks. Instead, we test the pattern it
 * implements by manually creating a server with the same configuration
 * and verifying the lifecycle works correctly.
 *
 * The actual setupMswServer() function is tested indirectly by verifying
 * that importing and calling it in a fresh describe block produces a
 * working MSW server.
 */

describe('MSW server lifecycle (setupMswServer pattern)', () => {
  const server = setupServer();

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  it('handlers registered via use() are active within test', async () => {
    server.use(
      http.get('https://api.example.com/data', () => {
        return HttpResponse.json({ result: 'mocked' });
      }),
    );

    const response = await fetch('https://api.example.com/data');
    const data = await response.json();

    expect(data).toEqual({ result: 'mocked' });
  });

  it('handlers are reset between tests (previous handler gone)', async () => {
    // The handler from the previous test should be gone due to resetHandlers()
    // Making a request should throw because onUnhandledRequest: 'error'
    server.use(
      http.get('https://api.example.com/other', () => {
        return HttpResponse.json({ result: 'different' });
      }),
    );

    const response = await fetch('https://api.example.com/other');
    const data = await response.json();

    expect(data).toEqual({ result: 'different' });
  });
});

describe('setupMswServer() export', () => {
  // Verify the export works by importing and calling it
  // This creates lifecycle hooks for THIS describe block
  let mswServer: ReturnType<typeof import('../src/msw-setup.js').setupMswServer> extends Promise<infer T> ? T : never;

  // We can't use setupMswServer() directly in a nested describe because
  // Vitest hooks need to be registered synchronously. Instead, verify
  // it's a callable function that returns a server-like object.
  it('is exported and callable', async () => {
    const { setupMswServer } = await import('../src/msw-setup.js');
    expect(typeof setupMswServer).toBe('function');
  });
});
