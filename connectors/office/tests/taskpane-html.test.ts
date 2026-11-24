import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSidecarCredential } from '../src/addin/taskpane.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const taskpaneHtmlPath = path.join(__dirname, '..', 'dist', 'addin', 'taskpane.html');

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const hasBuiltTaskpaneHtml = await fileExists(taskpaneHtmlPath);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Office bootstrap credential (new API, green-only contract coverage)', () => {
  const origin = 'https://localhost:52100';
  const assignment = (config: unknown) => `<script>window.__REBEL_SIDECAR_CONFIG=${JSON.stringify(config)};</script>`;
  const valid = { port: 52100, token: 'fictional-B', bridgeReady: false };
  function response(body = assignment(valid), url = `${origin}/taskpane.html`, type = 'text/html', redirected = false) {
    const result = new Response(body, { headers: { 'content-type': type } });
    Object.defineProperties(result, { url: { value: url }, redirected: { value: redirected } });
    return result;
  }
  function setup(fetchImpl: typeof fetch) {
    const config = { port: 52100, token: 'fictional-A', bridgeReady: true };
    vi.stubGlobal('window', { location: { origin, port: '52100' }, __REBEL_SIDECAR_CONFIG: config });
    vi.stubGlobal('fetch', fetchImpl);
    return { config, credential: createSidecarCredential(config) };
  }
  it('coalesces concurrent rejection, updates only the existing cell, and ignores a late old rejection', async () => {
    let release!: (value: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { config, credential } = setup(fetchImpl);
    const a = credential.noteRejected('fictional-A');
    const b = credential.noteRejected('fictional-A');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(response());
    expect(await Promise.all([a, b])).toEqual(['changed', 'changed']);
    expect(window.__REBEL_SIDECAR_CONFIG).toBe(config);
    expect(config).toEqual(valid);
    expect(await credential.noteRejected('fictional-A')).toBe('changed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${origin}/taskpane.html`);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'same-origin',
    });
  });
  it.each([
    ['missing', '<html></html>', `${origin}/taskpane.html`, 'text/html', false],
    ['duplicate', assignment(valid) + assignment(valid), `${origin}/taskpane.html`, 'text/html', false],
    ['executable suffix', assignment(valid).replace(';</script>', ';alert(1)</script>'), `${origin}/taskpane.html`, 'text/html', false],
    ['unknown field', assignment({ ...valid, unknown: true }), `${origin}/taskpane.html`, 'text/html', false],
    ['privileged field', assignment({ ...valid, pairedToken: 'fictional-secret' }), `${origin}/taskpane.html`, 'text/html', false],
    ['other port', assignment({ ...valid, port: 52101 }), `${origin}/taskpane.html`, 'text/html', false],
    ['empty token', assignment({ ...valid, token: '' }), `${origin}/taskpane.html`, 'text/html', false],
    ['cross origin', assignment(valid), 'https://example.com/taskpane.html', 'text/html', false],
    ['redirect', assignment(valid), `${origin}/taskpane.html`, 'text/html', true],
    ['wrong path', assignment(valid), `${origin}/other.html`, 'text/html', false],
    ['wrong type', assignment(valid), `${origin}/taskpane.html`, 'application/json', false],
  ] as const)('rejects %s without replacing the credential', async (_name, body, url, type, redirected) => {
    const { config, credential } = setup(vi.fn(async () => response(body, url, type, redirected)));
    expect(await credential.noteRejected('fictional-A')).toBe('unknown');
    expect(config).toEqual({ port: 52100, token: 'fictional-A', bridgeReady: true });
  });
  it('bounds a stalled refresh at five seconds and permits a later attempt', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const { credential } = setup(fetchImpl);
    const pending = credential.noteRejected('fictional-A');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe('unknown');
    expect(vi.getTimerCount()).toBe(0);
    fetchImpl.mockImplementation(async () => response());
    expect(await credential.noteRejected('fictional-A')).toBe('changed');
  });
});

function parseHtml(html: string): Document {
  const window = new Window();
  window.document.write(html);
  window.document.close();
  return window.document;
}

function hasHiddenOrDisplayNoneAncestry(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const style = current.getAttribute('style') ?? '';
    if (current.hasAttribute('hidden') || /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(style)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

describe.runIf(hasBuiltTaskpaneHtml)('built taskpane.html chat surface contract', () => {
  it('mounts the chat surface as the visible default and keeps the debug accordion collapsed', async () => {
    const html = await fs.readFile(taskpaneHtmlPath, 'utf8');
    const document = parseHtml(html);

    const chatRoot = document.querySelector('#chat-root');
    expect(chatRoot).not.toBeNull();
    expect(chatRoot?.hasAttribute('hidden')).toBe(false);
    expect(chatRoot?.getAttribute('style') ?? '').not.toMatch(/(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i);
    expect(hasHiddenOrDisplayNoneAncestry(chatRoot!)).toBe(false);

    const debug = document.querySelector('#debug');
    expect(debug).not.toBeNull();
    expect(debug?.getAttribute('data-open')).toBe('false');

    const debugPanel = document.querySelector('#debug-panel');
    expect(debugPanel).not.toBeNull();
    expect(debugPanel?.hasAttribute('hidden')).toBe(true);
    expect(debugPanel?.textContent).toContain('Recent Commands');

    const taskpaneScript = Array.from(document.querySelectorAll('script')).find((script) =>
      (script.getAttribute('src') ?? '').endsWith('taskpane.js'),
    );
    expect(taskpaneScript).toBeDefined();
  });
});
