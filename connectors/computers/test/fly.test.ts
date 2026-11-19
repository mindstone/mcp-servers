import { describe, it, expect, afterEach, vi } from 'vitest';
import { FlyProvider } from '../src/providers/fly.js';
import { API_REPLY_LIMIT, OUTPUT_LIMIT } from '../src/limits.js';
import { ConnectorError } from '../src/types.js';
import type { ComputerInfo } from '../src/provider.js';

vi.mock('../src/library.js', async (original) => ({ ...(await original<typeof import('../src/library.js')>()), MAX_FILE_BYTES: 64 * 1024 }));
const FILE_LIMIT = 64 * 1024;

const computer: ComputerInfo = { provider: 'fly', id: 'm1', name: 'one', state: 'running' };

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof ConnectorError ? error.code : `other: ${(error as Error).message}`;
  }
}

/** An exec reply of exactly `size` bytes of JSON. */
function execReply(size: number): string {
  const shell = JSON.stringify({ exit_code: 0, stdout: '', stderr: '' });
  return JSON.stringify({ exit_code: 0, stdout: 'a'.repeat(size - shell.length), stderr: '' });
}

/** A body sent in 64 KiB pieces that records whether the reader stopped it. */
function body(total: number) {
  const seen = { cancelled: false, sent: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.sent >= total) return controller.close();
      const piece = Math.min(64 * 1024, total - seen.sent);
      seen.sent += piece;
      controller.enqueue(new Uint8Array(piece).fill(0x61));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

describe('Fly.io reply limits', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a command reply of exactly the limit and refuses one byte more', async () => {
    let size = OUTPUT_LIMIT;
    vi.stubGlobal('fetch', async () => new Response(execReply(size), { status: 200 }));
    const fly = new FlyProvider('token', 'personal', 'app-x', 'ams');
    expect((await fly.exec(computer, 'true', 10)).exitCode).toBe(0);
    size = OUTPUT_LIMIT + 1;
    expect(await failure(fly.exec(computer, 'true', 10))).toBe('OUTPUT_TOO_LARGE');
  });

  it('allows other API replies more room, but not without limit', async () => {
    const { stream, seen } = body(API_REPLY_LIMIT + 1024 * 1024);
    vi.stubGlobal('fetch', async () => new Response(stream, { status: 200 }));
    const fly = new FlyProvider('token', 'personal', 'app-x', 'ams');
    expect(await failure(fly.list())).toBe('PROVIDER_ERROR');
    expect(seen.cancelled).toBe(true);
  });

  it('suggests FLY_APP when the organisation-wide app list is too large, and never suggests deleting computers', async () => {
    vi.stubGlobal('fetch', async () => new Response(body(API_REPLY_LIMIT + 1024 * 1024).stream, { status: 200 }));
    const error = await new FlyProvider('token', 'personal', undefined, 'ams').list().catch((e: unknown) => e as ConnectorError);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', message: 'Fly.io sent a reply too large to read safely.' });
    expect((error as ConnectorError).resolution).toContain('set the Fly.io app name (FLY_APP)');
    expect((error as ConnectorError).resolution).toContain('check its current state with computer_list');
    expect((error as ConnectorError).resolution).not.toMatch(/remove|delete computers/i);
  });
});

describe('Fly.io file transfers', () => {
  afterEach(() => vi.unstubAllGlobals());

  function serving(file: () => Response) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/exec')) return new Response(JSON.stringify({ exit_code: 0, stdout: 'k3y', stderr: '' }), { status: 200 });
      if (String(url).includes('/apps?')) return new Response(JSON.stringify({ apps: [{ name: 'mcp-computers-leak.example/' }] }), { status: 200 });
      return file();
    });
    return urls;
  }

  it('accepts a file of exactly the limit with no Content-Length', async () => {
    serving(() => new Response(body(FILE_LIMIT).stream, { status: 200 }));
    const fly = new FlyProvider('token', 'personal', 'app-x', 'ams');
    expect((await fly.download(computer, '/root/a.bin')).length).toBe(FILE_LIMIT);
  });

  it('counts the bytes that arrive, whatever Content-Length claims', async () => {
    const { stream, seen } = body(FILE_LIMIT * 4);
    serving(() => new Response(stream, { status: 200, headers: { 'content-length': '10' } }));
    const fly = new FlyProvider('token', 'personal', 'app-x', 'ams');
    expect(await failure(fly.download(computer, '/root/a.bin'))).toBe('FILE_TOO_LARGE');
    expect(seen.cancelled).toBe(true);
  });

  it('still refuses early when Content-Length is already over the limit', async () => {
    serving(() => new Response(body(FILE_LIMIT + 1).stream, { status: 200, headers: { 'content-length': String(FILE_LIMIT + 1) } }));
    const fly = new FlyProvider('token', 'personal', 'app-x', 'ams');
    expect(await failure(fly.download(computer, '/root/a.bin'))).toBe('FILE_TOO_LARGE');
  });

  for (const [label, app] of [
    ['set in FLY_APP', 'mcp-computers-x.evil.example'],
    ['found in the account', undefined],
  ] as const) {
    it(`never sends the file key to an app name that isn't one DNS label (${label})`, async () => {
      const urls = serving(() => new Response('data', { status: 200 }));
      const fly = new FlyProvider('token', 'personal', app, 'ams');
      expect(await failure(fly.download(computer, '/root/a.txt'))).toBe('PROVIDER_ERROR');
      expect(await failure(fly.upload(computer, '/root/a.txt', Buffer.from('x'), 'new'))).toBe('PROVIDER_ERROR');
      expect(urls.filter((url) => !url.startsWith('https://api.machines.dev/'))).toEqual([]);
      const error = await fly.download(computer, '/root/a.txt').catch((e: unknown) => e as ConnectorError);
      expect((error as ConnectorError).message).toBe('The file could not be transferred because the Fly.io app name is invalid.');
      expect(JSON.stringify(error) + (error as ConnectorError).message + (error as ConnectorError).resolution).not.toMatch(/evil|leak/);
    });
  }
});
