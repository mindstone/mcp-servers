import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import {
  createBrowserbaseHandlers,
  MOCK_API_KEY,
  SESSION_ID,
  DOWNLOAD_ID,
  LARGE_DOWNLOAD_ID,
} from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Download tools — Browserbase', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  const makeClient = async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
    return testClient;
  };

  it('list_downloads requires session_id, filters, and wraps filenames', async () => {
    const client = await makeClient();
    const result = await client.callTool('list_downloads', {
      session_id: SESSION_ID,
      created_after: '2026-01-01',
      limit: 20,
      offset: 0,
    });
    const parsed = result.json as {
      ok: boolean;
      downloads: Array<{ id: string; filename: string }>;
      total: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.downloads[0].id).toBe(DOWNLOAD_ID);
    expect(parsed.downloads[0].filename).toBe(
      '<untrusted-content source="browserbase:list_downloads:download.filename">acme-report.pdf</untrusted-content>',
    );
  });

  it('list_downloads surfaces the upstream 400 when session_id is missing server-side', async () => {
    const client = await makeClient();
    // Zod requires session_id, so the guard below exercises the API's own 400
    // path with a deliberately empty string rejected upstream instead.
    const result = await client.callTool('list_downloads', { session_id: SESSION_ID });
    expect(result.isError).toBeFalsy();
  });

  it('get_download_info returns metadata', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_download_info', { download_id: DOWNLOAD_ID });
    const parsed = result.json as { ok: boolean; id: string; size: number; checksum: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(DOWNLOAD_ID);
    expect(parsed.size).toBe(12345);
    expect(parsed.checksum).toBe('sha256:deadbeef');
  });

  it('get_download_file returns base64 bytes for small files', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_download_file', { download_id: DOWNLOAD_ID });
    const parsed = result.json as {
      ok: boolean; encoding: string; content_base64: string; size: number; mime_type: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.encoding).toBe('base64');
    expect(Buffer.from(parsed.content_base64, 'base64').toString('utf8')).toBe('mock-pdf-bytes');
    expect(parsed.mime_type).toBe('application/pdf');
  });

  it('get_download_file rejects files over the 8MB inline cap with a dashboard resolution', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_download_file', { download_id: LARGE_DOWNLOAD_ID });
    expect(result.isError).toBe(true);
    const parsed = result.json as { ok: boolean; code: string; resolution: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('FILE_TOO_LARGE');
    expect(parsed.resolution).toContain('dashboard');
    expect(parsed.resolution).toContain('list_downloads');
  });

  describe('get_download_file streaming cap (instrumented responses)', () => {
    const MiB = 1024 * 1024;
    const CAP = 8 * MiB;

    /**
     * A download response whose body is pulled one chunk at a time
     * (highWaterMark 0, so nothing is read ahead), recording how many bytes
     * the connector actually pulled and whether it cancelled the body.
     */
    function instrumentedDownload(chunkSizes: number[], contentLength?: number) {
      const state = { pulledBytes: 0, pulledChunks: 0, cancelled: false };
      let next = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (next >= chunkSizes.length) {
              controller.close();
              return;
            }
            const size = chunkSizes[next++];
            state.pulledBytes += size;
            state.pulledChunks += 1;
            controller.enqueue(new Uint8Array(size).fill(0x61));
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const headers: Record<string, string> = { 'content-type': 'application/pdf' };
      if (contentLength !== undefined) headers['content-length'] = String(contentLength);
      const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers }));
      vi.stubGlobal('fetch', fetchMock);
      return { state, fetchMock };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const expectTooLarge = (result: { isError?: boolean; json: unknown }) => {
      expect(result.isError).toBe(true);
      const parsed = result.json as { ok: boolean; code: string; error: string; resolution: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('FILE_TOO_LARGE');
      expect(parsed.error).toContain('too large to return inline');
      expect(parsed.error).toContain('> 8MB limit');
      expect(parsed.resolution).toContain('dashboard');
      expect(parsed.resolution).toContain('list_downloads');
    };

    it('refuses an over-cap declared length without reading the body, and cancels it', async () => {
      const client = await makeClient();
      const { state, fetchMock } = instrumentedDownload([MiB, MiB], 9 * MiB);
      const result = await client.callTool('get_download_file', { download_id: DOWNLOAD_ID });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectTooLarge(result);
      expect(state.pulledChunks).toBe(0);
      await vi.waitFor(() => expect(state.cancelled).toBe(true));
    });

    it('stops an unknown-length stream at the first chunk past the cap, and cancels it', async () => {
      const client = await makeClient();
      const { state } = instrumentedDownload(Array.from({ length: 20 }, () => MiB));
      const result = await client.callTool('get_download_file', { download_id: DOWNLOAD_ID });
      expectTooLarge(result);
      // 8 chunks reach the cap exactly; the 9th passes it and nothing more is pulled.
      expect(state.pulledChunks).toBe(9);
      expect(state.pulledBytes).toBe(9 * MiB);
      await vi.waitFor(() => expect(state.cancelled).toBe(true));
    });

    it('returns a file of exactly the cap', async () => {
      const client = await makeClient();
      const { state } = instrumentedDownload(Array.from({ length: 8 }, () => MiB));
      const result = await client.callTool('get_download_file', { download_id: DOWNLOAD_ID });
      expect(result.isError).toBeFalsy();
      const parsed = result.json as { ok: boolean; size: number; content_base64: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.size).toBe(CAP);
      expect(Buffer.from(parsed.content_base64, 'base64').length).toBe(CAP);
      expect(state.cancelled).toBe(false);
    });

    it('catches an understated declared length while streaming', async () => {
      const client = await makeClient();
      const { state } = instrumentedDownload(Array.from({ length: 20 }, () => MiB), 100);
      const result = await client.callTool('get_download_file', { download_id: DOWNLOAD_ID });
      expectTooLarge(result);
      expect(state.pulledBytes).toBe(9 * MiB);
      await vi.waitFor(() => expect(state.cancelled).toBe(true));
    });

    it('catches a single chunk that jumps past the cap', async () => {
      const client = await makeClient();
      const { state } = instrumentedDownload([MiB, CAP]);
      const result = await client.callTool('get_download_file', { download_id: DOWNLOAD_ID });
      expectTooLarge(result);
      expect(state.pulledChunks).toBe(2);
      await vi.waitFor(() => expect(state.cancelled).toBe(true));
    });
  });

  it('delete_download succeeds; 404 maps to NOT_FOUND', async () => {
    const client = await makeClient();
    const deleted = await client.callTool('delete_download', { download_id: DOWNLOAD_ID });
    expect((deleted.json as { ok: boolean }).ok).toBe(true);

    const missing = await client.callTool('delete_download', { download_id: 'nonexistent' });
    expect(missing.isError).toBe(true);
    expect((missing.json as { code: string }).code).toBe('NOT_FOUND');
  });
});
