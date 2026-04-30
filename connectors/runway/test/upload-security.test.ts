import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createBodyCapturingHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

const BASE = 'https://api.dev.runwayml.com/v1';

/**
 * Build a minimal handler set for upload_media flow. Handlers match in
 * registration order in MSW v2, so callers MUST spread these BEFORE any
 * generic "passthrough" handlers when overriding /uploads behaviour.
 */
function checkAuth(request: Request, expectedKey: string) {
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${expectedKey}`) {
    return HttpResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  return null;
}

/**
 * VAL-RUNWAY-001..008 — runway media-input file-read sandbox.
 *
 * These tests assert that any LLM-supplied local file path consumed by
 * `upload_media` or `resolveMediaInput` is sandboxed under
 * `RUNWAY_ALLOWED_ROOT` (default `os.tmpdir()`), with `realpathSync`-based
 * symlink-escape protection. HTTPS / `runway://` / `data:` URIs continue
 * to bypass the sandbox.
 */

/** Buffer of 1024 bytes filled with 0xab (above the 512-byte upload floor). */
const SAMPLE_BYTES = Buffer.alloc(1024, 0xab);

/**
 * MSW handlers covering only what `upload_media` touches: a counted POST
 * /uploads handler and a 204 responder for the signed-URL leg. The counter
 * is what tests use to assert "/uploads was (or was not) hit".
 */
function makeUploadHandlers() {
  const calls: Array<{ url: string }> = [];
  const uploadsHandler = http.post(`${BASE}/uploads`, ({ request }) => {
    const authError = checkAuth(request, MOCK_API_KEY);
    if (authError) return authError;
    calls.push({ url: request.url });
    return HttpResponse.json({
      uploadUrl: 'https://runway-uploads.example.com/upload',
      fields: { key: 'mcp-test-runway-upload-key', 'Content-Type': 'application/octet-stream' },
      runwayUri: 'runway://test-upload-001',
    });
  });
  const signedUrlHandler = http.post(
    'https://runway-uploads.example.com/upload',
    () => new HttpResponse(null, { status: 204 }),
  );
  return { uploadsHandler, signedUrlHandler, calls };
}

describe('Runway media-input sandbox (VAL-RUNWAY-001..008)', () => {
  let testClient: McpTestClient;
  let allowedRoot: string;
  let outsideRoot: string;
  let realpathAllowed: string;

  beforeEach(() => {
    // Two sibling tmp-dirs: one we'll allow-list, the other is "outside".
    allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-allowed-'));
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-outside-'));
    realpathAllowed = fs.realpathSync(allowedRoot);
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    // Best-effort cleanup; ignore errors so a failed assertion still produces
    // a useful test report.
    try { fs.rmSync(allowedRoot, { recursive: true, force: true }); } catch { /* empty */ }
    try { fs.rmSync(outsideRoot, { recursive: true, force: true }); } catch { /* empty */ }
  });

  // ── VAL-RUNWAY-001 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-001 — upload_media succeeds for a path inside RUNWAY_ALLOWED_ROOT', async () => {
    const filePath = path.join(allowedRoot, 'sample.png');
    fs.writeFileSync(filePath, SAMPLE_BYTES);

    const { uploadsHandler, signedUrlHandler, calls } = makeUploadHandlers();
    mswServer.use(uploadsHandler, signedUrlHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_ALLOWED_ROOT: allowedRoot,
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: filePath });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.text);
    expect(data.ok).toBe(true);
    expect(data.runway_uri).toMatch(/^runway:\/\//);
    expect(calls.length).toBe(1);
  });

  // ── VAL-RUNWAY-002 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-002 — default allow-listed root is os.tmpdir() when env is unset (positive)', async () => {
    const filePath = path.join(allowedRoot, 'sample.png');
    fs.writeFileSync(filePath, SAMPLE_BYTES);

    const { uploadsHandler, signedUrlHandler, calls } = makeUploadHandlers();
    mswServer.use(uploadsHandler, signedUrlHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_ALLOWED_ROOT: '',
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: filePath });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.text);
    expect(data.ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('VAL-RUNWAY-002 — default allow-listed root rejects paths outside os.tmpdir() (negative)', async () => {
    // /etc/hosts exists on macOS / Linux and is well outside any reasonable
    // os.tmpdir() value, so it functions as a stable "outside" path without
    // touching the user's homedir.
    // Use a non-existent path that is lexically OUTSIDE os.tmpdir(). This
    // avoids depending on platform-specific files (e.g. /etc/hosts size)
    // and avoids reading any real system file. Sandbox check must fire
    // BEFORE existsSync / size checks.
    const outsidePath = path.join('/var/empty/runway-mcp-outside-test', 'sample.png');

    const { uploadsHandler, signedUrlHandler, calls } = makeUploadHandlers();
    mswServer.use(uploadsHandler, signedUrlHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_ALLOWED_ROOT: '',
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: outsidePath });
    const data = JSON.parse(result.text);
    expect(data.ok).toBe(false);
    expect(String(data.error || data.code || '')).toMatch(/allowed|root|outside|sandbox/i);
    expect(calls.length).toBe(0);
  });

  // ── VAL-RUNWAY-003 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-003 — path outside RUNWAY_ALLOWED_ROOT is refused; /uploads not hit', async () => {
    const filePath = path.join(outsideRoot, 'sample.png');
    fs.writeFileSync(filePath, SAMPLE_BYTES);

    const { uploadsHandler, signedUrlHandler, calls } = makeUploadHandlers();
    mswServer.use(uploadsHandler, signedUrlHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_ALLOWED_ROOT: allowedRoot,
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: filePath });
    const data = JSON.parse(result.text);
    expect(data.ok).toBe(false);
    expect(String(data.error || data.code || '')).toMatch(/allowed|root|outside|sandbox/i);
    // /uploads must never have been hit — the upstream API never sees the
    // disallowed file's existence.
    expect(calls.length).toBe(0);
    // The disallowed file must remain on disk untouched (i.e. nothing about
    // the sandbox check truncated, opened-for-write, or moved it).
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath).length).toBe(SAMPLE_BYTES.length);
  });

  // ── VAL-RUNWAY-004 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-004 — path-traversal (..) escape is rejected', async () => {
    // Make sure /etc/passwd or /etc/hosts exists so that path-traversal
    // resolves to a real file (not a synthetic ENOENT case).
    const target = '/etc/hosts';
    if (!fs.existsSync(target)) return;
    const traversal = path.join(allowedRoot, '..', '..', '..', '..', '..', '..', 'etc', 'hosts');

    const { uploadsHandler, signedUrlHandler, calls } = makeUploadHandlers();
    mswServer.use(uploadsHandler, signedUrlHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_ALLOWED_ROOT: allowedRoot,
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: traversal });
    const data = JSON.parse(result.text);
    expect(data.ok).toBe(false);
    expect(String(data.error || data.code || '')).toMatch(/allowed|root|outside|sandbox/i);
    expect(calls.length).toBe(0);
  });

  // ── VAL-RUNWAY-005 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-005 — symlink inside the allow-listed root pointing outside is rejected', async () => {
    if (process.platform === 'win32') return; // symlinks require admin on Windows
    const secretPath = path.join(outsideRoot, 'secret.png');
    fs.writeFileSync(secretPath, SAMPLE_BYTES);
    const symlinkPath = path.join(allowedRoot, 'escape.png');
    fs.symlinkSync(secretPath, symlinkPath);

    const { uploadsHandler, signedUrlHandler, calls } = makeUploadHandlers();
    mswServer.use(uploadsHandler, signedUrlHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_ALLOWED_ROOT: allowedRoot,
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: symlinkPath });
    const data = JSON.parse(result.text);
    expect(data.ok).toBe(false);
    expect(String(data.error || data.code || '')).toMatch(/allowed|root|outside|sandbox/i);
    // /uploads must never have been hit — the secret file's existence is
    // not communicated upstream.
    expect(calls.length).toBe(0);
    // The secret content remains untouched on disk.
    expect(fs.existsSync(secretPath)).toBe(true);
    expect(fs.readFileSync(secretPath).length).toBe(SAMPLE_BYTES.length);
  });

  // ── VAL-RUNWAY-006 ────────────────────────────────────────────────────
  // Each entry: tool + the args payload that puts the malicious symlinked
  // path in the named media-input field. Tools that take >1 media arg fix
  // the OTHER args to a benign HTTPS URL so the targeted arg is the only
  // one being validated.
  type SymlinkCase = {
    label: string;
    tool: string;
    field: string;
    extraArgs: (symlink: string) => Record<string, unknown>;
    upstreamUrlFragment: string; // path fragment of the upstream API endpoint
  };
  const symlinkCases: SymlinkCase[] = [
    {
      label: 'prompt_image (generate_video_from_image)',
      tool: 'generate_video_from_image',
      field: 'prompt_image',
      extraArgs: (s) => ({ prompt_image: s, prompt_text: 'go' }),
      upstreamUrlFragment: '/image_to_video',
    },
    {
      label: 'last_frame_image (generate_video_from_image)',
      tool: 'generate_video_from_image',
      field: 'last_frame_image',
      extraArgs: (s) => ({
        prompt_image: 'https://example.com/start.jpg',
        last_frame_image: s,
        prompt_text: 'morph',
      }),
      upstreamUrlFragment: '/image_to_video',
    },
    {
      label: 'video (generate_video_from_video)',
      tool: 'generate_video_from_video',
      field: 'video',
      extraArgs: (s) => ({ video: s, prompt_text: 'restyle' }),
      upstreamUrlFragment: '/video_to_video',
    },
    {
      label: 'reference_image (generate_video_from_video)',
      tool: 'generate_video_from_video',
      field: 'reference_image',
      extraArgs: (s) => ({
        video: 'https://example.com/in.mp4',
        prompt_text: 'restyle',
        reference_image: s,
      }),
      upstreamUrlFragment: '/video_to_video',
    },
    {
      label: 'character (character_performance)',
      tool: 'character_performance',
      field: 'character',
      extraArgs: (s) => ({ character: s, reference_video: 'https://example.com/perf.mp4' }),
      upstreamUrlFragment: '/character_performance',
    },
    {
      label: 'reference_video (character_performance)',
      tool: 'character_performance',
      field: 'reference_video',
      extraArgs: (s) => ({ character: 'https://example.com/char.png', reference_video: s }),
      upstreamUrlFragment: '/character_performance',
    },
    {
      label: 'media (swap_voice)',
      tool: 'swap_voice',
      field: 'media',
      extraArgs: (s) => ({ media: s, voice: 'Maya' }),
      upstreamUrlFragment: '/speech_to_speech',
    },
    {
      label: 'audio (dub_audio)',
      tool: 'dub_audio',
      field: 'audio',
      extraArgs: (s) => ({ audio: s, target_language: 'es' }),
      upstreamUrlFragment: '/voice_dubbing',
    },
    {
      label: 'audio (isolate_voice)',
      tool: 'isolate_voice',
      field: 'audio',
      extraArgs: (s) => ({ audio: s }),
      upstreamUrlFragment: '/voice_isolation',
    },
  ];

  for (const c of symlinkCases) {
    it(`VAL-RUNWAY-006 — symlink-escape rejected via resolveMediaInput on ${c.label}`, async () => {
      if (process.platform === 'win32') return;
      const secretPath = path.join(outsideRoot, 'secret.bin');
      fs.writeFileSync(secretPath, SAMPLE_BYTES);
      const symlinkPath = path.join(allowedRoot, 'escape.bin');
      fs.symlinkSync(secretPath, symlinkPath);

      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: {
          RUNWAYML_API_SECRET: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          RUNWAY_ALLOWED_ROOT: allowedRoot,
        },
      });

      const result = await testClient.callTool(c.tool, c.extraArgs(symlinkPath));
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(false);
      expect(String(data.error || data.code || '')).toMatch(/allowed|root|outside|sandbox/i);

      // Upstream generation endpoint must not have been hit.
      const hits = capturedBodies.filter((b) => b.url.includes(c.upstreamUrlFragment));
      expect(hits.length).toBe(0);
    });
  }

  // ── VAL-RUNWAY-007 ────────────────────────────────────────────────────
  const passthroughUris = [
    { label: 'https://', uri: 'https://example.com/photo.jpg' },
    { label: 'runway://', uri: 'runway://uploads/abc' },
    {
      label: 'data:',
      // 1×1 transparent PNG, well under the data-URI inline cap.
      uri:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA' +
        'fFcSJAAAADUlEQVR42mNkYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==',
    },
  ];
  for (const p of passthroughUris) {
    it(`VAL-RUNWAY-007 — ${p.label} URI passes through unchanged (no sandbox regression)`, async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: {
          RUNWAYML_API_SECRET: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          RUNWAY_ALLOWED_ROOT: allowedRoot,
        },
      });

      const result = await testClient.callTool('generate_video_from_image', {
        prompt_image: p.uri,
        prompt_text: 'pan',
        model: 'gen4_turbo',
      });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);

      const body = capturedBodies.find((b) => b.url.includes('/image_to_video'))?.body as Record<string, unknown>;
      expect(body).toBeDefined();
      expect(body.promptImage).toBe(p.uri);
    });
  }

  // ── VAL-RUNWAY-008 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-008 — non-existent path inside allow-list returns existing FILE_NOT_FOUND-style error', async () => {
    const missing = path.join(allowedRoot, 'does-not-exist.png');
    expect(fs.existsSync(missing)).toBe(false);

    const { uploadsHandler, signedUrlHandler, calls } = makeUploadHandlers();
    mswServer.use(uploadsHandler, signedUrlHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_ALLOWED_ROOT: allowedRoot,
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: missing });
    const data = JSON.parse(result.text);
    expect(data.ok).toBe(false);
    // Pre-fix error string remains the canonical "File not found" — the
    // sandbox path is not the one that fired.
    expect(String(data.error || '')).toMatch(/File not found/i);
    expect(calls.length).toBe(0);

    // Use realpathAllowed in an assertion so the variable is referenced
    // (and to document the sandbox root used).
    expect(missing.startsWith(allowedRoot) || missing.startsWith(realpathAllowed)).toBe(true);
  });
});
