import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  createKlingHandlers,
  mockExtendTaskId,
  mockLipSyncTaskId,
  mockVideoId,
} from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';

const BASE = 'https://api-singapore.klingai.com/v1';

function clientEnv(extra: Record<string, string> = {}) {
  return {
    KLING_ACCESS_KEY: ACCESS_KEY,
    KLING_SECRET_KEY: SECRET_KEY,
    MCP_HOST_BRIDGE_STATE: '',
    ...extra,
  };
}

describe('extend_kling_video', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('submits an extension task (happy path)', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(`${BASE}/videos/video-extend`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ code: 0, message: 'success', data: { task_id: mockExtendTaskId } });
      }),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('extend_kling_video', {
      video_id: mockVideoId,
      prompt: 'The dog runs toward the camera',
      negative_prompt: 'blurry',
    });

    const json = result.json as { ok: boolean; task_id: string; task_type: string };
    expect(json.ok).toBe(true);
    expect(json.task_id).toBe(mockExtendTaskId);
    expect(json.task_type).toBe('video-extend');
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.video_id).toBe(mockVideoId);
    expect(capturedBody!.prompt).toBe('The dog runs toward the camera');
    expect(capturedBody!.negative_prompt).toBe('blurry');
  });

  it('forwards callback_url when provided', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(`${BASE}/videos/video-extend`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ code: 0, message: 'success', data: { task_id: mockExtendTaskId } });
      }),
    );
    testClient = await createTestClient({ env: clientEnv() });

    await testClient.callTool('extend_kling_video', {
      video_id: mockVideoId,
      callback_url: 'https://example.com/webhook',
    });

    expect(capturedBody!.callback_url).toBe('https://example.com/webhook');
  });

  it('rejects a non-HTTPS callback_url', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('extend_kling_video', {
      video_id: mockVideoId,
      callback_url: 'http://example.com/webhook',
    });

    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_URL');
  });

  it('check_kling_task resolves a video-extend task and surfaces the video id', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('check_kling_task', {
      task_id: mockExtendTaskId,
      task_type: 'video-extend',
    });

    const json = result.json as {
      ok: boolean;
      status: string;
      video: { id: string; url: string; duration: string };
    };
    expect(json.ok).toBe(true);
    expect(json.status).toBe('succeed');
    expect(json.video.id).toBe('video-extended-789');
    expect(json.video.url).toContain('klingai.com');
  });
});

describe('generate_kling_lip_sync', () => {
  let testClient: McpTestClient;
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-lipsync-ws-'));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* empty */ }
  });

  it('submits a text2video lip-sync task (happy path)', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(`${BASE}/videos/lip-sync`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ code: 0, message: 'success', data: { task_id: mockLipSyncTaskId } });
      }),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_lip_sync', {
      video_id: mockVideoId,
      mode: 'text2video',
      text: 'Welcome back to the channel',
      voice_id: 'oversea_male1',
      voice_language: 'en',
      voice_speed: 1.2,
    });

    const json = result.json as { ok: boolean; task_id: string; task_type: string };
    expect(json.ok).toBe(true);
    expect(json.task_id).toBe(mockLipSyncTaskId);
    expect(json.task_type).toBe('lip-sync');
    const input = capturedBody!.input as Record<string, unknown>;
    expect(input.mode).toBe('text2video');
    expect(input.video_id).toBe(mockVideoId);
    expect(input.text).toBe('Welcome back to the channel');
    expect(input.voice_id).toBe('oversea_male1');
    expect(input.voice_language).toBe('en');
    expect(input.voice_speed).toBe(1.2);
  });

  it('sends a workspace-local audio file as base64 in audio2video mode', async () => {
    const audioBytes = Buffer.alloc(4096, 0x42);
    const audioPath = path.join(workspace, 'voice.mp3');
    fs.writeFileSync(audioPath, audioBytes);
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(`${BASE}/videos/lip-sync`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ code: 0, message: 'success', data: { task_id: mockLipSyncTaskId } });
      }),
    );
    testClient = await createTestClient({ env: clientEnv({ MCP_WORKSPACE_PATH: workspace }) });

    const result = await testClient.callTool('generate_kling_lip_sync', {
      video_url: 'https://example.com/clip.mp4',
      mode: 'audio2video',
      audio_path: audioPath,
    });

    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    const input = capturedBody!.input as Record<string, unknown>;
    expect(input.mode).toBe('audio2video');
    expect(input.video_url).toBe('https://example.com/clip.mp4');
    expect(input.audio_type).toBe('file');
    expect(input.audio_file).toBe(audioBytes.toString('base64'));
  });

  it('rejects both video_id and video_url together', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_lip_sync', {
      video_id: mockVideoId,
      video_url: 'https://example.com/clip.mp4',
      mode: 'text2video',
      text: 'hello',
      voice_id: 'oversea_male1',
    });

    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_INPUT');
  });

  it('requires text and voice_id in text2video mode', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const noText = await testClient.callTool('generate_kling_lip_sync', {
      video_id: mockVideoId,
      mode: 'text2video',
      voice_id: 'oversea_male1',
    });
    expect((noText.json as { code: string }).code).toBe('INVALID_INPUT');

    const noVoice = await testClient.callTool('generate_kling_lip_sync', {
      video_id: mockVideoId,
      mode: 'text2video',
      text: 'hello',
    });
    expect((noVoice.json as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('requires audio input in audio2video mode', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_lip_sync', {
      video_id: mockVideoId,
      mode: 'audio2video',
    });

    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_INPUT');
  });

  it('refuses an audio file outside the workspace before any outbound request', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-lipsync-outside-'));
    const outsideAudio = path.join(outsideDir, 'voice.mp3');
    fs.writeFileSync(outsideAudio, Buffer.alloc(1024, 0x43));
    let requestCount = 0;
    mswServer.use(
      http.post(`${BASE}/videos/lip-sync`, () => {
        requestCount++;
        return HttpResponse.json({ code: 0, message: 'success', data: { task_id: 'x' } });
      }),
    );
    testClient = await createTestClient({ env: clientEnv({ MCP_WORKSPACE_PATH: workspace }) });

    const result = await testClient.callTool('generate_kling_lip_sync', {
      video_id: mockVideoId,
      mode: 'audio2video',
      audio_path: outsideAudio,
    });

    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('PATH_OUTSIDE_WORKSPACE');
    expect(requestCount).toBe(0);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('check_kling_task resolves a lip-sync task', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('check_kling_task', {
      task_id: mockLipSyncTaskId,
      task_type: 'lip-sync',
    });

    const json = result.json as { ok: boolean; status: string; video: { url: string } };
    expect(json.ok).toBe(true);
    expect(json.status).toBe('succeed');
    expect(json.video.url).toContain('klingai.com');
  });
});

describe('check_kling_task — video id surfacing', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('includes the video id in a succeeded text2video result', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('check_kling_task', {
      task_id: 'task-kling-abc123',
      task_type: 'text2video',
    });

    const json = result.json as { ok: boolean; video: { id: string } };
    expect(json.ok).toBe(true);
    expect(json.video.id).toBe(mockVideoId);
  });
});
