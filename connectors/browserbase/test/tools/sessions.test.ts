import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createBrowserbaseHandlers, MOCK_API_KEY, PROJECT_ID, SESSION_ID } from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Session tools — Browserbase', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  const makeClient = async (env: Record<string, string> = {}) => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '', ...env },
    });
    return testClient;
  };

  it('create_session maps snake_case inputs to the API body and returns connectUrl', async () => {
    const client = await makeClient();
    const result = await client.callTool('create_session', {
      project_id: PROJECT_ID,
      keep_alive: true,
      timeout: 600,
      region: 'eu-central-1',
      browser_settings: {
        viewport: { width: 1920, height: 1080 },
        blockAds: true,
        os: 'mac',
        context: { id: 'ctx_1', persist: true },
      },
      user_metadata: { ticket: 'ACME-123' },
    });
    expect(result.isError).toBeFalsy();
    const parsed = result.json as { ok: boolean; id: string; connectUrl: string; status: string; userMetadata: { ticket: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(SESSION_ID);
    expect(parsed.connectUrl).toContain('wss://');
    expect(parsed.status).toBe('RUNNING');
    // userMetadata is caller-supplied JSON echoed back → wrapped.
    expect(parsed.userMetadata.ticket).toContain('<untrusted-content');
  });

  it('list_sessions filters by status', async () => {
    const client = await makeClient();
    const result = await client.callTool('list_sessions', { status: 'RUNNING' });
    const parsed = result.json as { ok: boolean; sessions: unknown[]; count: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
  });

  it('get_session returns the session with connectUrl', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_session', { session_id: SESSION_ID });
    const parsed = result.json as { ok: boolean; id: string; connectUrl: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(SESSION_ID);
    expect(parsed.connectUrl).toContain('wss://');
  });

  it('get_session maps a non-UUID id to a 400 VALIDATION_FAILED error', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_session', { session_id: 'not-a-uuid' });
    expect(result.isError).toBe(true);
    const parsed = result.json as { ok: boolean; code: string; error: string };
    expect(parsed.code).toBe('VALIDATION_FAILED');
    expect(parsed.error).toContain('<untrusted-content source="browserbase:error">Invalid Session ID</untrusted-content>');
  });

  it('end_session sends REQUEST_RELEASE semantics', async () => {
    const client = await makeClient();
    const result = await client.callTool('end_session', { session_id: SESSION_ID });
    const parsed = result.json as { ok: boolean; message: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('REQUEST_RELEASE');
  });

  it('create_session surfaces 429 RATE_LIMITED with the retry-after window', async () => {
    const client = await makeClient();
    const result = await client.callTool('create_session', { project_id: 'trigger-429' });
    expect(result.isError).toBe(true);
    const parsed = result.json as { ok: boolean; code: string; resolution: string };
    expect(parsed.code).toBe('RATE_LIMITED');
    expect(parsed.resolution).toContain('17 seconds');
  });

  it('get_session_debug_urls wraps page-controlled url/title fields', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_session_debug_urls', { session_id: SESSION_ID });
    const parsed = result.json as {
      ok: boolean;
      debuggerFullscreenUrl: string;
      pages: Array<{ url: string; title: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.debuggerFullscreenUrl).toContain('https://');
    expect(parsed.pages[0].url).toBe(
      '<untrusted-content source="browserbase:get_session_debug_urls:page.url">https://example.com/pricing</untrusted-content>',
    );
    // The mock title contains a close-tag breakout attempt — it must be neutralised.
    expect(parsed.pages[0].title).toContain('<\\/untrusted-content>');
    expect(parsed.pages[0].title.startsWith('<untrusted-content')).toBe(true);
  });

  it('get_session_logs wraps CDP payloads and truncates oversized rawBody', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_session_logs', { session_id: SESSION_ID });
    const parsed = result.json as {
      ok: boolean;
      logs: Array<{ request: { rawBody: string }; response: { rawBody: string } }>;
      count: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    const reqRaw = parsed.logs[0].request.rawBody;
    expect(reqRaw.startsWith('<untrusted-content')).toBe(true);
    // The mock rawBody is >5KB — must be truncated to ~4KB with a note.
    expect(reqRaw).toContain('[truncated');
    expect(reqRaw.length).toBeLessThan(4600);
    // Small bodies pass through intact (wrapped but not truncated).
    expect(parsed.logs[0].response.rawBody).toContain('{"status":200}');
    expect(parsed.logs[0].response.rawBody).not.toContain('[truncated');
  });

  it('get_session_replays lists replay pages with wrapped urls', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_session_replays', { session_id: SESSION_ID });
    const parsed = result.json as { ok: boolean; pages: Array<{ pageId: string; url: string }>; pageCount: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.pages[0].url).toContain('<untrusted-content');
  });

  it('get_session_replay_playlist returns the m3u8 text wrapped as untrusted', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_session_replay_playlist', { session_id: SESSION_ID, page_id: '0' });
    const parsed = result.json as { ok: boolean; playlist: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.playlist).toContain('#EXTM3U');
    expect(parsed.playlist.startsWith('<untrusted-content')).toBe(true);
  });

  it('request_session_recording_downloads returns 202 semantics; get_session_recording_downloads returns signed URLs', async () => {
    const client = await makeClient();
    const req = await client.callTool('request_session_recording_downloads', { session_id: SESSION_ID });
    expect((req.json as { ok: boolean }).ok).toBe(true);
    expect((req.json as { message: string }).message).toContain('202');

    const get = await client.callTool('get_session_recording_downloads', { session_id: SESSION_ID });
    const parsed = get.json as { ok: boolean; downloads: Array<{ status: string; downloadUrl: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.downloads[0].status).toBe('COMPLETED');
    expect(parsed.downloads[0].downloadUrl).toContain('https://cdn.browserbase.com');
  });

  it('request_session_recording_downloads maps 409 to CONFLICT', async () => {
    const client = await makeClient();
    const result = await client.callTool('request_session_recording_downloads', { session_id: 'conflict-session' });
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('CONFLICT');
  });

  it('get_session_recording_downloads maps 410 to GONE', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_session_recording_downloads', { session_id: 'expired-session' });
    expect(result.isError).toBe(true);
    const parsed = result.json as { code: string; resolution: string };
    expect(parsed.code).toBe('GONE');
    expect(parsed.resolution).toContain('expired');
  });

  it('upload_session_file uploads a workspace file and rejects paths outside the sandbox', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-workspace-'));
    const insidePath = path.join(workspace, 'data.csv');
    fs.writeFileSync(insidePath, 'a,b,c\n1,2,3\n');
    const outsidePath = path.join(os.tmpdir(), `bb-outside-${Date.now()}.csv`);
    fs.writeFileSync(outsidePath, 'secret\n');

    try {
      const client = await makeClient({ MCP_WORKSPACE_PATH: workspace });

      const ok = await client.callTool('upload_session_file', { session_id: SESSION_ID, file_path: insidePath });
      const okJson = ok.json as { ok: boolean; message: string };
      expect(okJson.ok).toBe(true);
      expect(okJson.message).toContain('/tmp/.uploads/data.csv');

      const bad = await client.callTool('upload_session_file', { session_id: SESSION_ID, file_path: outsidePath });
      expect(bad.isError).toBe(true);
      const badJson = bad.json as { ok: boolean; code: string; error: string };
      expect(badJson.ok).toBe(false);
      expect(badJson.code).toBe('FILE_OUTSIDE_WORKSPACE');
      expect(badJson.error).toContain('workspace sandbox');

      // Traversal that escapes the sandbox is rejected too.
      const traversal = await client.callTool('upload_session_file', {
        session_id: SESSION_ID,
        file_path: path.join(workspace, '..', path.basename(outsidePath)),
      });
      expect(traversal.isError).toBe(true);
      expect((traversal.json as { code: string }).code).toBe('FILE_OUTSIDE_WORKSPACE');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outsidePath, { force: true });
    }
  });
});
