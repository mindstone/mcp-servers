import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/opus-data.js';

const CDN = 'https://ext.cdn.opus.pro';
const CLIP_URL = `${CDN}/media/org_xxx/P2061602abcd/c.CU67da38/ehd.mp4?v=123`;
const CLIP_BYTES = new TextEncoder().encode('fake-mp4-bytes');

let workspace: string;
let testClient: McpTestClient | undefined;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-dl-'));
});

afterEach(async () => {
  if (testClient) {
    await testClient.close();
    testClient = undefined;
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function freshClient(): Promise<McpTestClient> {
  testClient = await createTestClient({
    env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspace },
  });
  return testClient;
}

function serveClip(bytes: Uint8Array = CLIP_BYTES) {
  mswServer.use(
    http.get(`${CDN}/media/*`, () =>
      HttpResponse.arrayBuffer(bytes.buffer as ArrayBuffer, {
        headers: { 'Content-Type': 'video/mp4' },
      }),
    ),
  );
}

describe('opus_download_clip', () => {
  it('downloads a clip into the workspace (happy path)', async () => {
    serveClip();
    const client = await freshClient();
    const out = path.join(workspace, 'clip.mp4');
    const result = await client.callTool('opus_download_clip', {
      url: CLIP_URL,
      output_path: out,
    });
    expect(result.isError).toBeFalsy();
    const data = result.json as { ok: boolean; bytes: number };
    expect(data.ok).toBe(true);
    expect(data.bytes).toBe(CLIP_BYTES.length);
    expect(fs.readFileSync(out)).toEqual(Buffer.from(CLIP_BYTES));
  });

  it('refuses to overwrite an existing file unless overwrite=true', async () => {
    serveClip();
    const client = await freshClient();
    const out = path.join(workspace, 'clip.mp4');
    fs.writeFileSync(out, 'pre-existing');

    const refused = await client.callTool('opus_download_clip', {
      url: CLIP_URL,
      output_path: out,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('OUTPUT_EXISTS');
    expect(fs.readFileSync(out, 'utf8')).toBe('pre-existing');

    const overwritten = await client.callTool('opus_download_clip', {
      url: CLIP_URL,
      output_path: out,
      overwrite: true,
    });
    expect(overwritten.isError).toBeFalsy();
    expect(fs.readFileSync(out)).toEqual(Buffer.from(CLIP_BYTES));
  });

  it('rejects an output_path outside the workspace before any network call', async () => {
    let networkTouched = false;
    mswServer.use(
      http.get(`${CDN}/media/*`, () => {
        networkTouched = true;
        return HttpResponse.arrayBuffer(new ArrayBuffer(0));
      }),
    );
    const client = await freshClient();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-dl-outside-'));
    try {
      const result = await client.callTool('opus_download_clip', {
        url: CLIP_URL,
        output_path: path.join(outside, 'clip.mp4'),
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('PATH_OUTSIDE_WORKSPACE');
      expect(networkTouched).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a non-HTTPS URL', async () => {
    const client = await freshClient();
    const result = await client.callTool('opus_download_clip', {
      url: 'http://ext.cdn.opus.pro/media/x.mp4',
      output_path: path.join(workspace, 'clip.mp4'),
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('URL_REJECTED');
  });

  it('rejects a private-network URL', async () => {
    const client = await freshClient();
    const result = await client.callTool('opus_download_clip', {
      url: 'https://169.254.169.254/latest/meta-data',
      output_path: path.join(workspace, 'clip.mp4'),
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('URL_REJECTED');
  });

  it('refuses a redirect to a private-network host', async () => {
    mswServer.use(
      http.get(`${CDN}/media/*`, () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://169.254.169.254/latest/meta-data' },
        }),
      ),
    );
    const client = await freshClient();
    const out = path.join(workspace, 'clip.mp4');
    const result = await client.callTool('opus_download_clip', {
      url: CLIP_URL,
      output_path: out,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('DOWNLOAD_REDIRECT_REFUSED');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('follows a safe redirect and downloads', async () => {
    mswServer.use(
      http.get(`${CDN}/media/redirect/*`, () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: `${CDN}/media/final/clip.mp4` },
        }),
      ),
      http.get(`${CDN}/media/final/*`, () =>
        HttpResponse.arrayBuffer(CLIP_BYTES.buffer as ArrayBuffer),
      ),
    );
    const client = await freshClient();
    const out = path.join(workspace, 'clip.mp4');
    const result = await client.callTool('opus_download_clip', {
      url: `${CDN}/media/redirect/clip.mp4`,
      output_path: out,
    });
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(out)).toEqual(Buffer.from(CLIP_BYTES));
  });

  it('cleans up the partial file when the download fails', async () => {
    mswServer.use(
      http.get(`${CDN}/media/*`, () => HttpResponse.json({ error: 'gone' }, { status: 410 })),
    );
    const client = await freshClient();
    const out = path.join(workspace, 'clip.mp4');
    const result = await client.callTool('opus_download_clip', {
      url: CLIP_URL,
      output_path: out,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('DOWNLOAD_FAILED');
    expect(fs.existsSync(out)).toBe(false);
  });
});
