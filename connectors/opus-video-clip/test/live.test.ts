/**
 * Live API smoke test against the real OpusClip API.
 *
 * Guarded behind `OPUS_LIVE_TEST=1` so it never runs in CI.
 *
 * Required env:
 *   OPUS_API_KEY  — a real OpusClip API key
 *
 * Optional env:
 *   OPUS_LIVE_VIDEO_URL  — public video URL to use for create-project (defaults
 *                           to a short Big Buck Bunny clip).
 *   OPUS_LIVE_WAIT_FOR_CLIPS=1
 *                          — if set, poll opus_get_project until COMPLETE
 *                            (can take 3–10 minutes; defaults to OFF).
 *
 * Skipped by default (would publish to real social accounts or burn credits):
 *   • opus_upload_video        — covered by unit tests, requires a real local file
 *   • opus_publish_post        — would post to a connected page
 *   • opus_schedule_post       — would publish later
 *   • opus_cancel_scheduled_post — paired with schedule_post
 *   • opus_create_censor_job   — needs an exportable clip URL; exercised
 *                                opportunistically iff a clip URL is available
 *   • opus_create_social_copy_job / opus_get_social_copy_job
 *                              — runs opportunistically iff a clip is available
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';

const LIVE = process.env.OPUS_LIVE_TEST === '1';
const WAIT_FOR_CLIPS = process.env.OPUS_LIVE_WAIT_FOR_CLIPS === '1';
const REUSE_PROJECT_ID = process.env.OPUS_LIVE_REUSE_PROJECT_ID;
const WAIT_DEADLINE_MIN = Number(process.env.OPUS_LIVE_WAIT_MINUTES ?? 15);
const VIDEO_URL =
  process.env.OPUS_LIVE_VIDEO_URL ??
  // Short Creative-Commons YouTube test video (Big Buck Bunny ~33s teaser).
  // YouTube is the canonical happy-path source for Opus.
  'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

const describeLive = LIVE ? describe : describe.skip;

interface LiveCtx {
  client?: McpTestClient;
  projectId?: string;
  brandTemplateId?: string;
  collectionId?: string;
  clipFullId?: string;
  clipExportUrl?: string;
  curationId?: string;
  socialCopyJobId?: string;
}

const ctx: LiveCtx = {};

async function callJSON(name: string, args: unknown): Promise<{ isError?: boolean; data: any; text: string }> {
  if (!ctx.client) throw new Error('client not initialised');
  const r = await ctx.client.callTool(name, args as Record<string, unknown>);
  // eslint-disable-next-line no-console
  console.log(`\n[live] ${name} → isError=${!!r.isError}`);
  if (r.text) {
    const snippet = r.text.length < 2000 ? r.text : r.text.slice(0, 2000) + '\n…[truncated]';
    console.log(snippet);
  }
  return { isError: r.isError, data: r.json, text: r.text };
}

describeLive('Opus connector — LIVE API', () => {
  beforeAll(async () => {
    if (!process.env.OPUS_API_KEY) {
      throw new Error('OPUS_API_KEY is required for live tests');
    }
    // Stub env so the server's auth module picks it up at import time.
    process.env.OPUS_API_KEY = process.env.OPUS_API_KEY;
    const { createServer } = await import('../src/server.js');
    ctx.client = await createInMemoryTestClient({ createServer });
  }, 30_000);

  afterAll(async () => {
    if (ctx.client) await ctx.client.close();
  });

  it('lists 21 tools', async () => {
    const tools = await ctx.client!.client.listTools();
    expect(tools.tools.length).toBe(21);
  });

  it('opus_get_brand_templates returns at least 0 templates without errors', async () => {
    const { isError, data } = await callJSON('opus_get_brand_templates', { q: 'mine' });
    expect(isError).toBeFalsy();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.brand_templates)).toBe(true);
    if (data.brand_templates.length > 0) {
      ctx.brandTemplateId = data.brand_templates[0].id;
      // eslint-disable-next-line no-console
      console.log(`[live] using brand template: ${ctx.brandTemplateId}`);
    }
  }, 30_000);

  it('opus_create_project from a public video URL (or reuse existing)', async () => {
    if (REUSE_PROJECT_ID) {
      ctx.projectId = REUSE_PROJECT_ID;
      // eslint-disable-next-line no-console
      console.log(`[live] reusing existing project: ${ctx.projectId}`);
      return;
    }
    const { isError, data } = await callJSON('opus_create_project', {
      videoUrl: VIDEO_URL,
      ...(ctx.brandTemplateId ? { brandTemplateId: ctx.brandTemplateId } : {}),
    });
    expect(isError).toBeFalsy();
    expect(data.ok).toBe(true);
    expect(data.projectId).toBeTruthy();
    ctx.projectId = data.projectId;
    // eslint-disable-next-line no-console
    console.log(`[live] created project: ${ctx.projectId} (stage=${data.stage})`);
  }, 60_000);

  it('opus_get_project reflects current stage', async () => {
    expect(ctx.projectId).toBeTruthy();
    const { isError, data } = await callJSON('opus_get_project', { projectId: ctx.projectId! });
    expect(isError).toBeFalsy();
    expect(data.ok).toBe(true);
    expect(['PENDING', 'QUEUED', 'IMPORT', 'CURATE', 'REFINE', 'RENDER', 'UPLOAD', 'COMPLETE', 'STALLED']).toContain(
      data.stage,
    );
  }, 30_000);

  it('opus_share_project — PUBLIC then DEFAULT round-trip', async () => {
    expect(ctx.projectId).toBeTruthy();
    const pub = await callJSON('opus_share_project', {
      projectId: ctx.projectId!,
      visibility: 'PUBLIC',
    });
    expect(pub.isError).toBeFalsy();
    expect(pub.data.visibility).toBe('PUBLIC');

    const def = await callJSON('opus_share_project', {
      projectId: ctx.projectId!,
      visibility: 'DEFAULT',
    });
    expect(def.isError).toBeFalsy();
    expect(def.data.visibility).toBe('DEFAULT');
  }, 30_000);

  it('opus_get_social_accounts (read-only, may be empty)', async () => {
    const { isError, data } = await callJSON('opus_get_social_accounts', { q: 'mine' });
    expect(isError).toBeFalsy();
    expect(data.ok).toBe(true);
    if (data.accounts && data.accounts.length > 0) {
      const first = data.accounts[0];
      (ctx as any).postAccountId = first.postAccountId;
      (ctx as any).subAccountId = first.subAccountId;
    }
    // eslint-disable-next-line no-console
    console.log(`[live] connected social accounts: ${data.count}`);
  }, 30_000);

  it('opus_create_collection / opus_get_collections / opus_delete_collection round-trip', async () => {
    const name = `live-test-${Date.now()}`;
    const created = await callJSON('opus_create_collection', { collectionName: name });
    expect(created.isError).toBeFalsy();
    expect(created.data.ok).toBe(true);
    const collectionId = created.data.collection?.collectionId ?? created.data.collectionId;
    expect(collectionId).toBeTruthy();
    ctx.collectionId = collectionId;

    const list = await callJSON('opus_get_collections', { q: 'mine' });
    expect(list.isError).toBeFalsy();
    expect(list.data.ok).toBe(true);
    expect(list.data.count).toBeGreaterThan(0);

    // export the (empty) collection — should succeed even with no contents
    const exp = await callJSON('opus_export_collection', { collectionId });
    expect(exp.isError).toBeFalsy();

    // delete it
    const del = await callJSON('opus_delete_collection', { collectionId });
    expect(del.isError).toBeFalsy();
    expect(del.data.ok).toBe(true);
    ctx.collectionId = undefined;
  }, 60_000);

  it(
    'opus_get_clips after project COMPLETE (opportunistic best-effort)',
    async () => {
      if (!WAIT_FOR_CLIPS) {
        console.log('[live] WAIT_FOR_CLIPS=0 — skipping clip polling');
        return;
      }
      expect(ctx.projectId).toBeTruthy();

      const deadline = Date.now() + WAIT_DEADLINE_MIN * 60_000;
      let stage = 'PENDING';
      while (Date.now() < deadline) {
        const p = await callJSON('opus_get_project', { projectId: ctx.projectId! });
        stage = p.data.stage;
        if (stage === 'COMPLETE') break;
        if (stage === 'STALLED') throw new Error('project stalled');
        await new Promise((r) => setTimeout(r, 15_000));
      }
      if (stage !== 'COMPLETE') {
        // eslint-disable-next-line no-console
        console.log(
          `[live] project did not COMPLETE within ${WAIT_DEADLINE_MIN}m (stage=${stage}); ` +
            `re-run later with OPUS_LIVE_REUSE_PROJECT_ID=${ctx.projectId} OPUS_LIVE_WAIT_FOR_CLIPS=1 to resume polling.`,
        );
        return;
      }

      const clips = await callJSON('opus_get_clips', {
        q: 'findByProjectId',
        projectId: ctx.projectId!,
      });
      expect(clips.isError).toBeFalsy();
      expect(clips.data.count).toBeGreaterThan(0);
      const first = clips.data.clips[0];
      ctx.clipFullId = first.id;
      ctx.curationId = first.curationId;
      ctx.clipExportUrl = first.uriForExport;
    },
    (WAIT_DEADLINE_MIN + 2) * 60_000,
  );

  it('opus_add_clip_to_collection / remove_clip_from_collection (opportunistic)', async () => {
    if (!ctx.clipFullId) {
      console.log('[live] no clips available; skipping collection-contents test');
      return;
    }
    const created = await callJSON('opus_create_collection', {
      collectionName: `live-test-contents-${Date.now()}`,
    });
    const collectionId = created.data.collection?.collectionId ?? created.data.collectionId;

    const add = await callJSON('opus_add_clip_to_collection', {
      collectionId,
      contentId: ctx.clipFullId,
    });
    expect(add.isError).toBeFalsy();

    const remove = await callJSON('opus_remove_clip_from_collection', {
      collectionId,
      contentId: ctx.clipFullId,
    });
    expect(remove.isError).toBeFalsy();

    await callJSON('opus_delete_collection', { collectionId });
  }, 60_000);

  it('opus_create_censor_job + opus_get_censor_job_status (opportunistic)', async () => {
    if (!ctx.projectId || !ctx.curationId) {
      console.log('[live] no project/curation available; skipping censor');
      return;
    }
    const job = await callJSON('opus_create_censor_job', {
      projectId: ctx.projectId,
      clipId: ctx.curationId,
    });
    expect(job.isError).toBeFalsy();
    const jobId = job.data.jobId;
    if (!jobId) {
      // Degenerate-success path — no profanity found, no job queued.
      // eslint-disable-next-line no-console
      console.log('[live] no censored words — degenerate-success path validated');
      expect(job.data.status).toBe('NO_CENSORED_WORDS');
      expect(job.data.category).toBe('completed');
      return;
    }
    const status = await callJSON('opus_get_censor_job_status', { jobId, attempt: 1 });
    expect(status.isError).toBeFalsy();
    expect(['queued', 'pending', 'completed', 'failed', 'unknown']).toContain(status.data.category);
  }, 60_000);

  it('opus_create_social_copy_job + opus_get_social_copy_job (opportunistic)', async () => {
    const postAccountId = (ctx as any).postAccountId as string | undefined;
    const subAccountId = (ctx as any).subAccountId as string | undefined;
    if (!ctx.projectId || !ctx.curationId || !postAccountId || !subAccountId) {
      console.log('[live] missing project/curation/socialAccount; skipping social-copy');
      return;
    }
    const job = await callJSON('opus_create_social_copy_job', {
      projectId: ctx.projectId,
      clipId: ctx.curationId,
      postAccountId,
      subAccountId,
    });
    expect(job.isError).toBeFalsy();
    const jobId = job.data.jobId;
    expect(jobId).toBeTruthy();

    const status = await callJSON('opus_get_social_copy_job', { jobId, attempt: 1 });
    expect(status.isError).toBeFalsy();
    expect(['queued', 'pending', 'completed', 'failed', 'unknown']).toContain(status.data.category);
  }, 90_000);

  it('SKIPPED LIVE (publish_post / schedule_post / cancel_scheduled_post / upload_video)', () => {
    expect(true).toBe(true);
  });
});
