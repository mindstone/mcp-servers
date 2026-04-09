import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { createBridgeHandlers } from '../src/index.js';

describe('createBridgeHandlers', () => {
  const mswServer = setupServer();

  beforeAll(() => {
    mswServer.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    mswServer.resetHandlers();
  });

  afterAll(() => {
    mswServer.close();
  });

  it('returns 401 without Bearer token (VAL-FOUND-003)', async () => {
    mswServer.use(...createBridgeHandlers(9876));

    const response = await fetch('http://127.0.0.1:9876/configure', {
      method: 'POST',
      body: JSON.stringify({ action: 'configure' }),
    });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain('authorization');
  });

  it('returns 401 with non-Bearer auth header', async () => {
    mswServer.use(...createBridgeHandlers(9876));

    const response = await fetch('http://127.0.0.1:9876/configure', {
      method: 'POST',
      headers: { Authorization: 'Basic abc123' },
      body: JSON.stringify({ action: 'configure' }),
    });

    expect(response.status).toBe(401);
  });

  it('returns success with valid Bearer token (VAL-FOUND-003)', async () => {
    mswServer.use(...createBridgeHandlers(9876));

    const response = await fetch('http://127.0.0.1:9876/configure', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-123' },
      body: JSON.stringify({ action: 'configure' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('returns custom success data when provided', async () => {
    mswServer.use(...createBridgeHandlers(9876, {
      successData: { credentials: { apiKey: 'stored' } },
    }));

    const response = await fetch('http://127.0.0.1:9876/store-credential', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify({ key: 'value' }),
    });

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.credentials).toEqual({ apiKey: 'stored' });
  });

  it('returns error response when error option is set', async () => {
    mswServer.use(...createBridgeHandlers(9876, {
      error: 'Storage unavailable',
    }));

    const response = await fetch('http://127.0.0.1:9876/configure', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify({}),
    });

    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe('Storage unavailable');
  });

  it('works with different port numbers', async () => {
    mswServer.use(...createBridgeHandlers(54321));

    const response = await fetch('http://127.0.0.1:54321/any-path', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});
