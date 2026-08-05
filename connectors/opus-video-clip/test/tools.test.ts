import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mswServer } from './helpers/setup.js';
import { createOpusHandlers } from './helpers/opus-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_API_KEY,
  mockProjectId,
  mockCollectionId,
  mockCensorJobId,
  mockJobId,
  mockBrandTemplates,
  makeCensorJobNoWords,
} from './fixtures/opus-data.js';

const BASE = 'https://api.opus.pro';

describe('Opus tool behaviour (MSW-mocked)', () => {
  let testClient: McpTestClient | undefined;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined;
    }
    vi.unstubAllEnvs();
  });

  describe('opus_get_brand_templates', () => {
    it('passes q=mine and returns templates', async () => {
      let receivedQ: string | null = null;
      mswServer.use(
        http.get(`${BASE}/api/brand-templates`, ({ request }) => {
          const url = new URL(request.url);
          receivedQ = url.searchParams.get('q');
          return HttpResponse.json(mockBrandTemplates);
        }),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_get_brand_templates', { q: 'mine' });
      expect(result.isError).toBeFalsy();
      expect(receivedQ).toBe('mine');
      const data = result.json as { ok: boolean; count: number; brand_templates: unknown[] };
      expect(data.ok).toBe(true);
      expect(data.count).toBe(2);
    });

    it('sends Bearer auth', async () => {
      let capturedAuth = '';
      mswServer.use(
        http.get(`${BASE}/api/brand-templates`, ({ request }) => {
          capturedAuth = request.headers.get('Authorization') ?? '';
          return HttpResponse.json(mockBrandTemplates);
        }),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      await testClient.callTool('opus_get_brand_templates', { q: 'mine' });
      expect(capturedAuth).toBe(`Bearer ${MOCK_API_KEY}`);
    });

    it('rejects q values other than "mine" at schema level', async () => {
      mswServer.use(...createOpusHandlers());
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      // @ts-expect-error — testing runtime Zod rejection
      const result = await testClient.callTool('opus_get_brand_templates', { q: 'all' });
      expect(result.isError).toBe(true);
    });
  });

  describe('opus_create_project', () => {
    it('forwards body and surfaces projectId', async () => {
      let captured: Record<string, unknown> = {};
      mswServer.use(
        http.post(`${BASE}/api/clip-projects`, async ({ request }) => {
          captured = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { id: mockProjectId, projectId: mockProjectId, stage: 'QUEUED' },
            { status: 201 },
          );
        }),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_create_project', {
        videoUrl: 'https://example.com/video.mp4',
        brandTemplateId: 'preset-fancy-Karaoke',
      });
      expect(result.isError).toBeFalsy();
      expect(captured.videoUrl).toBe('https://example.com/video.mp4');
      expect(captured.brandTemplateId).toBe('preset-fancy-Karaoke');
      const data = result.json as { projectId: string };
      expect(data.projectId).toBe(mockProjectId);
    });
  });

  describe('opus_get_clips', () => {
    it('requires projectId when q=findByProjectId', async () => {
      mswServer.use(...createOpusHandlers());
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_get_clips', { q: 'findByProjectId' });
      expect(result.isError).toBe(true);
    });

    it('forwards x-opus-org-id when provided', async () => {
      let receivedOrgId: string | null = null;
      mswServer.use(
        http.get(`${BASE}/api/exportable-clips`, ({ request }) => {
          receivedOrgId = request.headers.get('x-opus-org-id');
          return HttpResponse.json([]);
        }),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      await testClient.callTool('opus_get_clips', {
        q: 'findByProjectId',
        projectId: mockProjectId,
        orgId: 'org_Eo5kdhZN7638',
      });
      expect(receivedOrgId).toBe('org_Eo5kdhZN7638');
    });
  });

  describe('opus_share_project', () => {
    it('accepts PUBLIC visibility', async () => {
      mswServer.use(...createOpusHandlers());
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_share_project', {
        projectId: mockProjectId,
        visibility: 'PUBLIC',
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects unknown visibility at schema level', async () => {
      mswServer.use(...createOpusHandlers());
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      // @ts-expect-error
      const result = await testClient.callTool('opus_share_project', {
        projectId: mockProjectId,
        visibility: 'private',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('opus_create_collection / get / export / delete', () => {
    it('round-trips collection CRUD', async () => {
      mswServer.use(...createOpusHandlers());
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const created = await testClient.callTool('opus_create_collection', {
        collectionName: 'Demo',
      });
      expect((created.json as { ok: boolean }).ok).toBe(true);

      const listed = await testClient.callTool('opus_get_collections', { q: 'mine' });
      expect((listed.json as { count: number }).count).toBe(1);

      const exported = await testClient.callTool('opus_export_collection', {
        collectionId: mockCollectionId,
      });
      expect((exported.json as { count: number }).count).toBe(1);

      const deleted = await testClient.callTool('opus_delete_collection', {
        collectionId: mockCollectionId,
      });
      expect((deleted.json as { ok: boolean }).ok).toBe(true);
    });
  });

  describe('collection-contents POST-to-delete idiom', () => {
    it('removes a clip via POST /delete-collection-contents with q in body', async () => {
      let calledPath = '';
      let usedMethod = '';
      let receivedBody: any = null;
      mswServer.use(
        http.post(`${BASE}/api/collection-contents/delete-collection-contents`, async ({ request }) => {
          const url = new URL(request.url);
          calledPath = url.pathname;
          usedMethod = request.method;
          receivedBody = await request.json();
          return HttpResponse.json({ data: 'success' });
        }),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_remove_clip_from_collection', {
        collectionId: mockCollectionId,
        contentId: 'P1.C1',
      });
      expect(result.isError).toBeFalsy();
      expect(calledPath).toBe('/api/collection-contents/delete-collection-contents');
      expect(usedMethod).toBe('POST');
      expect(receivedBody.q).toBe('findByCollectionIdAndContentId');
      expect(receivedBody.collectionId).toBe(mockCollectionId);
      expect(receivedBody.contentId).toBe('P1.C1');
    });
  });

  describe('opus_create_censor_job degenerate-success path', () => {
    it('surfaces "no censored words" as completed with jobId=null', async () => {
      mswServer.use(
        http.post(`${BASE}/api/censor-jobs`, () => HttpResponse.json(makeCensorJobNoWords())),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_create_censor_job', {
        projectId: mockProjectId,
        clipId: 'CU67da38',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as { jobId: string | null; category: string; status: string };
      expect(data.jobId).toBeNull();
      expect(data.category).toBe('completed');
      expect(data.status).toBe('NO_CENSORED_WORDS');
    });
  });

  describe('opus_create_censor_job / status', () => {
    it('classifies CONCLUDED as completed', async () => {
      mswServer.use(...createOpusHandlers());
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const status = await testClient.callTool('opus_get_censor_job_status', {
        jobId: mockCensorJobId,
      });
      expect(status.isError).toBeFalsy();
      const data = status.json as { category: string; status: string };
      expect(data.category).toBe('completed');
      expect(data.status).toBe('CONCLUDED');
    });

    it('treats UNKNOWN status as UPSTREAM_STATUS_UNKNOWN (not pending)', async () => {
      mswServer.use(
        http.get(`${BASE}/api/censor-jobs/:jobId`, () =>
          HttpResponse.json({ status: 'UNKNOWN' }),
        ),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const status = await testClient.callTool('opus_get_censor_job_status', {
        jobId: mockCensorJobId,
      });
      const data = status.json as { category: string; error_code?: string };
      expect(data.category).toBe('unknown');
      expect(data.error_code).toBe('UPSTREAM_STATUS_UNKNOWN');
    });

    it('honours Retry-After header in seconds form', async () => {
      mswServer.use(
        http.get(`${BASE}/api/censor-jobs/:jobId`, () =>
          HttpResponse.json(
            { status: 'PROCESSING' },
            { headers: { 'Retry-After': '7' } },
          ),
        ),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const status = await testClient.callTool('opus_get_censor_job_status', {
        jobId: mockCensorJobId,
        attempt: 1,
      });
      const data = status.json as { next_poll_after_seconds: number };
      expect(data.next_poll_after_seconds).toBe(7);
    });

    it('honours Retry-After header in HTTP-date form', async () => {
      const futureTime = new Date(Date.now() + 12_000).toUTCString();
      mswServer.use(
        http.get(`${BASE}/api/censor-jobs/:jobId`, () =>
          HttpResponse.json(
            { status: 'PROCESSING' },
            { headers: { 'Retry-After': futureTime } },
          ),
        ),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const status = await testClient.callTool('opus_get_censor_job_status', {
        jobId: mockCensorJobId,
        attempt: 1,
      });
      const data = status.json as { next_poll_after_seconds: number };
      expect(data.next_poll_after_seconds).toBeGreaterThanOrEqual(10);
      expect(data.next_poll_after_seconds).toBeLessThanOrEqual(13);
    });

    it('falls back to exponential backoff when Retry-After is absent', async () => {
      mswServer.use(
        http.get(`${BASE}/api/censor-jobs/:jobId`, () =>
          HttpResponse.json({ status: 'PROCESSING' }),
        ),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const first = await testClient.callTool('opus_get_censor_job_status', {
        jobId: mockCensorJobId,
        attempt: 1,
      });
      const fifth = await testClient.callTool('opus_get_censor_job_status', {
        jobId: mockCensorJobId,
        attempt: 5,
      });
      const a = first.json as { next_poll_after_seconds: number };
      const b = fifth.json as { next_poll_after_seconds: number };
      expect(a.next_poll_after_seconds).toBeGreaterThanOrEqual(5);
      expect(b.next_poll_after_seconds).toBeGreaterThan(a.next_poll_after_seconds);
      expect(b.next_poll_after_seconds).toBeLessThanOrEqual(30);
    });
  });

  describe('social copy job classification', () => {
    it('returns title/description/hashtags on COMPLETED', async () => {
      mswServer.use(...createOpusHandlers());
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_get_social_copy_job', { jobId: mockJobId });
      const data = result.json as { title: string; description: string; hashtags: string };
      expect(data.title).toBe('Demo Title');
      expect(data.description).toContain('Demo');
      expect(data.hashtags).toContain('#Demo');
    });
  });

  describe('opus_upload_video workspace sandbox (invariant #5)', () => {
    it('refuses a file outside MCP_WORKSPACE_PATH before any network call', async () => {
      let networkTouched = false;
      mswServer.use(
        http.post(`${BASE}/api/upload-links`, () => {
          networkTouched = true;
          return HttpResponse.json({});
        }),
      );
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-upload-ws-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-upload-outside-'));
      try {
        const secretFile = path.join(outside, 'secret.mp4');
        fs.writeFileSync(secretFile, 'fake-bytes');
        testClient = await createTestClient({
          env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspace },
        });
        const result = await testClient.callTool('opus_upload_video', { file_path: secretFile });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('PATH_OUTSIDE_WORKSPACE');
        expect(networkTouched).toBe(false);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('uploads a file inside the workspace and creates a project (happy path)', async () => {
      mswServer.use(...createOpusHandlers());
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-upload-ws-'));
      try {
        const videoFile = path.join(workspace, 'demo.mp4');
        fs.writeFileSync(videoFile, Buffer.alloc(1024, 7));
        testClient = await createTestClient({
          env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspace },
        });
        const result = await testClient.callTool('opus_upload_video', {
          file_path: videoFile,
          curationPref: { model: 'ClipBasic', topicKeywords: ['demo'] },
        });
        expect(result.isError).toBeFalsy();
        const data = result.json as { ok: boolean; projectId: string; uploadId: string };
        expect(data.ok).toBe(true);
        expect(data.projectId).toBe(mockProjectId);
        expect(data.uploadId).toBeTruthy();
      } finally {
        // Let the GCS PUT read-stream finish releasing the file before cleanup.
        await new Promise((r) => setTimeout(r, 100));
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  describe('error normalisation', () => {
    it('returns AUTH_FAILED on 401', async () => {
      mswServer.use(
        http.get(`${BASE}/api/brand-templates`, () =>
          HttpResponse.json({ error: 'Invalid API key' }, { status: 401 }),
        ),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: 'bad-key', MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_get_brand_templates', { q: 'mine' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_FAILED');
    });

    it('parses Retry-After on 429', async () => {
      mswServer.use(
        http.get(`${BASE}/api/brand-templates`, () =>
          HttpResponse.json(
            { error: 'rate-limited' },
            { status: 429, headers: { 'Retry-After': '23' } },
          ),
        ),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_get_brand_templates', { q: 'mine' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('23 seconds');
    });

    it('returns NOT_FOUND on 404', async () => {
      mswServer.use(
        http.get(`${BASE}/api/clip-projects/:id`, () =>
          HttpResponse.json({}, { status: 404 }),
        ),
      );
      testClient = await createTestClient({
        env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('opus_get_project', { projectId: 'P_missing' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('NOT_FOUND');
    });
  });
});
