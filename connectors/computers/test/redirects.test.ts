import { describe, it, expect, afterEach, vi } from 'vitest';
import { FlyProvider } from '../src/providers/fly.js';

// A computer controls its own file service, so it must never be able to redirect a transfer elsewhere.
describe('Fly requests never follow redirects', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks fetch to refuse redirects on the API and on file transfers', async () => {
    const seen: Array<RequestRedirect | undefined> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push(init.redirect);
      if (String(url).includes('/exec')) return new Response(JSON.stringify({ exit_code: 0, stdout: 'k3y', stderr: '' }), { status: 200 });
      if (String(url).includes('.fly.dev/files')) return new Response('data', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const fly = new FlyProvider('token', 'personal', 'app-x', 'ams');
    await fly.download({ provider: 'fly', id: 'm1', name: 'one', state: 'running' }, '/root/a.txt');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((r) => r === 'error')).toBe(true);
  });
});
