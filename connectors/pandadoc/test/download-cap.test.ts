import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { mswServer } from './helpers/setup.js';
import { createPandaDocHandlers } from './helpers/pandadoc-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { readBodyCapped } from '../src/client.js';
import { MAX_DOWNLOAD_SIZE, PandaDocError } from '../src/types.js';

const BASE = 'https://api.pandadoc.com/public/v1';
const MB = 1024 * 1024;

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

/** A stream of `count` chunks of `size` bytes, generated lazily. */
function lazyStream(count: number, size: number, onCancel?: () => void): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < count) {
        sent++;
        controller.enqueue(new Uint8Array(size).fill(0x41));
      } else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PandaDocError);
  expect((err as PandaDocError).code).toBe(code);
}

describe('readBodyCapped', () => {
  it('rejects early on a Content-Length over the cap and cancels the body', async () => {
    let cancelled = false;
    const response = new Response(lazyStream(1, 4, () => (cancelled = true)), {
      headers: { 'Content-Length': '11' },
    });
    await expectCode(readBodyCapped(response, 10), 'DOWNLOAD_TOO_LARGE');
    expect(cancelled).toBe(true);
  });

  it('counts bytes even when Content-Length understates the body', async () => {
    const response = new Response(streamOf([new Uint8Array(6), new Uint8Array(6)]), {
      headers: { 'Content-Length': '3' },
    });
    await expectCode(readBodyCapped(response, 10), 'DOWNLOAD_TOO_LARGE');
  });

  it('cancels a streamed body once it exceeds the cap', async () => {
    let cancelled = false;
    const response = new Response(lazyStream(100, 4, () => (cancelled = true)));
    await expectCode(readBodyCapped(response, 10), 'DOWNLOAD_TOO_LARGE');
    expect(cancelled).toBe(true);
  });

  it('refuses a single chunk larger than the cap', async () => {
    const response = new Response(streamOf([new Uint8Array(11)]));
    await expectCode(readBodyCapped(response, 10), 'DOWNLOAD_TOO_LARGE');
  });

  it.each(['abc', '-5', '1e3', '99999999999999999999999999'])(
    'still refuses an oversized body when Content-Length is %s',
    async (declared) => {
      const response = new Response(streamOf([new Uint8Array(6), new Uint8Array(6)]), {
        headers: { 'Content-Length': declared },
      });
      // A huge all-digit value is an early refusal; anything malformed falls
      // back to counting. Either way the oversized body is refused.
      await expectCode(readBodyCapped(response, 10), 'DOWNLOAD_TOO_LARGE');
    },
  );

  it('accepts a body of exactly the cap', async () => {
    const response = new Response(streamOf([new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7, 8, 9, 10])]));
    const buffer = await readBodyCapped(response, 10);
    expect([...buffer]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('returns an empty buffer for a null body', async () => {
    const buffer = await readBodyCapped(new Response(null), 10);
    expect(buffer.length).toBe(0);
  });

  it('maps a body read timeout to TIMEOUT', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
        controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
      },
    });
    const err = await readBodyCapped(new Response(stream), 10).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PandaDocError);
    expect((err as PandaDocError).code).toBe('TIMEOUT');
    expect((err as PandaDocError).message).toBe('Request to PandaDoc API timed out');
  });

  it('maps an aborted body read to TIMEOUT', async () => {
    // Stands in for fetch erroring the body when the request signal aborts.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new DOMException('This operation was aborted', 'AbortError'));
      },
    });
    await expectCode(readBodyCapped(new Response(stream), 10), 'TIMEOUT');
  });

  it('maps a real timeout signal firing mid-body to TIMEOUT', async () => {
    const signal = AbortSignal.timeout(50);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(2));
        signal.addEventListener('abort', () => c.error(signal.reason));
      },
    });
    await expectCode(readBodyCapped(new Response(stream), 10), 'TIMEOUT');
  });

  it('propagates other read errors unchanged', async () => {
    const boom = new Error('socket hang up');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(boom);
      },
    });
    await expect(readBodyCapped(new Response(stream), 10)).rejects.toBe(boom);
  });
});

describe('download_document size cap', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  function tempFilesFor(docId: string): string[] {
    const tmpRoot = fs.realpathSync(os.tmpdir());
    return fs.readdirSync(tmpRoot).filter((name) => name.startsWith(`pandadoc_${docId}_`));
  }

  async function download(docId: string) {
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });
    return testClient.callTool('download_document', { document_id: docId });
  }

  it('refuses a download whose Content-Length is over the cap and writes no file', async () => {
    const docId = `doc-cl-${Date.now()}`;
    mswServer.use(
      http.get(`${BASE}/documents/:id/download`, () => {
        return new HttpResponse(lazyStream(1, 16), {
          status: 200,
          headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(MAX_DOWNLOAD_SIZE + 1) },
        });
      }),
      ...createPandaDocHandlers(),
    );
    const result = await download(docId);
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('DOWNLOAD_TOO_LARGE');
    expect(json.error).toContain('50 MB');
    expect(tempFilesFor(docId)).toEqual([]);
  });

  it('refuses a streamed download over the cap with no Content-Length and writes no file', async () => {
    const docId = `doc-stream-${Date.now()}`;
    mswServer.use(
      http.get(`${BASE}/documents/:id/download`, () => {
        return new HttpResponse(lazyStream(MAX_DOWNLOAD_SIZE / MB + 1, MB), {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        });
      }),
      ...createPandaDocHandlers(),
    );
    const result = await download(docId);
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('DOWNLOAD_TOO_LARGE');
    expect(tempFilesFor(docId)).toEqual([]);
  });

  it('writes the exact bytes of a small download', async () => {
    const docId = `doc-small-${Date.now()}`;
    const bytes = Buffer.from('%PDF-1.7 small body');
    mswServer.use(
      http.get(`${BASE}/documents/:id/download`, () => {
        return new HttpResponse(streamOf([bytes.subarray(0, 5), bytes.subarray(5)]), {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        });
      }),
      ...createPandaDocHandlers(),
    );
    const result = await download(docId);
    const json = result.json as { ok: boolean; file_path: string };
    expect(json.ok).toBe(true);
    try {
      expect(fs.readFileSync(json.file_path).equals(bytes)).toBe(true);
    } finally {
      fs.rmSync(json.file_path, { force: true });
    }
  });
});
