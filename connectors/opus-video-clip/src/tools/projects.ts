import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey } from '../auth.js';
import { opusFetch } from '../client.js';
import { OpusError, SHARE_VISIBILITY } from '../types.js';
import { sanitizeClip, sanitizeList, sanitizeProject } from '../sanitize.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';

interface ClipProjectRepresentation {
  id?: string;
  projectId?: string;
  stage?: string;
  model?: string;
  error?: string | null;
  [key: string]: unknown;
}

interface ExportableClipRepresentation {
  id?: string;
  projectId?: string;
  curationId?: string;
  uriForPreview?: string;
  uriForExport?: string;
  durationMs?: number;
  title?: string;
  [key: string]: unknown;
}

export const ConclusionActionSchema = z
  .object({
    type: z.enum(['EMAIL', 'WEBHOOK']),
    notifyFailure: z.boolean().optional(),
    email: z.string().email().optional(),
    url: z.string().url().optional(),
  })
  .describe(
    "Action to take when the project completes. Use type='EMAIL' with `email`, or type='WEBHOOK' with `url`.",
  );

const RangeSchema = z
  .object({
    startSec: z.number().nonnegative().optional(),
    endSec: z.number().nonnegative().optional(),
  })
  .optional();

export const CurationPreferenceSchema = z
  .object({
    model: z.enum(['ClipBasic', 'ClipAnything']).optional(),
    clipDurations: z.array(z.array(z.number().nonnegative())).optional(),
    topicKeywords: z.array(z.string()).optional(),
    customPrompt: z.string().optional(),
    genre: z.string().optional(),
    range: RangeSchema,
    skipCurate: z.boolean().optional(),
  })
  .describe(
    'Curation preferences. Use `model: "ClipBasic"` for talking-head videos with `topicKeywords`, or `model: "ClipAnything"` with `customPrompt` for any video type. Set `skipCurate: true` to upload without clipping.',
  );

export const ImportPreferenceSchema = z
  .object({
    sourceLang: z.string().optional().describe('ISO-639 language code, e.g. "en", "de", "auto".'),
  });

export const RenderPreferenceSchema = z
  .object({
    layoutAspectRatio: z.enum(['portrait', 'landscape', 'square']).optional(),
    quickstartConfig: z
      .object({
        enableRemoveFillerWords: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

export const UploadedVideoAttrSchema = z
  .object({
    title: z.string().optional(),
  });

export const CreateProjectInputSchema = z.object({
  videoUrl: z
    .string()
    .min(1)
    .describe(
      'Public URL of the source video (YouTube, Google Drive, Vimeo, Zoom, Rumble, Twitch, Facebook, LinkedIn, X, Dropbox, Riverside, Loom, Frame.io, StreamYard, or a public S3 MP4 link up to 10GB). For local files, call opus_upload_video first and pass the uploadId here.',
    ),
  brandTemplateId: z
    .string()
    .optional()
    .describe('Brand template ID from opus_get_brand_templates (e.g. "preset-fancy-Karaoke")'),
  curationPref: CurationPreferenceSchema.optional(),
  renderPref: RenderPreferenceSchema.optional(),
  importPref: ImportPreferenceSchema.optional(),
  uploadedVideoAttr: UploadedVideoAttrSchema.optional(),
  conclusionActions: z.array(ConclusionActionSchema).optional(),
});

export function registerProjectTools(server: McpServer): void {
  // ── opus_create_project ───────────────────────────────────────────

  server.registerTool(
    'opus_create_project',
    {
      description:
        'Create a new OpusClip clipping project from a publicly importable long-form video URL. ' +
        'After this returns a projectId, poll opus_get_project to track stage progression (PENDING → QUEUED → IMPORT → CURATE → REFINE → RENDER → UPLOAD → COMPLETE). ' +
        'When complete, call opus_get_clips to retrieve the generated clips. ' +
        'For local files, use opus_upload_video instead — it handles upload-link generation, GCS resumable upload, and project creation in a single tool call.',
      inputSchema: CreateProjectInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<ClipProjectRepresentation>('/api/clip-projects', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      return JSON.stringify(
        {
          ok: true,
          projectId: result.id ?? result.projectId,
          stage: result.stage,
          message:
            'Project created. Poll opus_get_project with this projectId until stage="COMPLETE", then call opus_get_clips.',
          project: sanitizeProject(result, 'opus:create_project'),
        },
        null,
        2,
      );
    }),
  );

  // ── opus_get_project ──────────────────────────────────────────────

  server.registerTool(
    'opus_get_project',
    {
      description:
        'Retrieve the current status and metadata of an OpusClip project. ' +
        'Check the `stage` field — when it reaches "COMPLETE" the clips are ready (use opus_get_clips). ' +
        'If `stage` is "STALLED" or `error` is set, the project has failed.',
      inputSchema: z.object({
        projectId: z.string().min(1).describe('The OpusClip projectId returned by opus_create_project'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await opusFetch<ClipProjectRepresentation>(
        `/api/clip-projects/${encodeURIComponent(args.projectId)}`,
      );
      return JSON.stringify(
        {
          ok: true,
          projectId: result.id ?? result.projectId,
          stage: result.stage,
          model: result.model,
          error: wrapUntrusted(result.error ?? undefined, 'opus:get_project:error') ?? null,
          project: sanitizeProject(result, 'opus:get_project'),
        },
        null,
        2,
      );
    }),
  );

  // ── opus_get_clips ────────────────────────────────────────────────

  server.registerTool(
    'opus_get_clips',
    {
      description:
        'List the exportable clips for a given project or collection. ' +
        'Each clip has a full-clip id of the form `{projectId}.{curationId}`, plus preview/export URLs (`uriForPreview`, `uriForExport`) on Google Cloud Storage. ' +
        'Choose `q: "findByProjectId"` and pass `projectId`, OR `q: "findByCollectionId"` and pass `collectionId`. Pagination via `pageNum` (starts at 1) and `pageSize`.',
      inputSchema: z
        .object({
          q: z
            .enum(['findByProjectId', 'findByCollectionId'])
            .describe('Query type — find clips by project or by collection.'),
          projectId: z.string().optional(),
          collectionId: z.string().optional(),
          pageNum: z.number().int().positive().optional(),
          pageSize: z.number().int().positive().max(100).optional(),
          orgId: z
            .string()
            .optional()
            .describe(
              'Optional `x-opus-org-id` header value. Required when your account has multiple organisations.',
            ),
        })
        .refine(
          (v) =>
            (v.q === 'findByProjectId' && !!v.projectId) ||
            (v.q === 'findByCollectionId' && !!v.collectionId),
          {
            message:
              'projectId is required when q="findByProjectId"; collectionId is required when q="findByCollectionId".',
          },
        ),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const params = new URLSearchParams();
      params.set('q', args.q);
      if (args.projectId) params.set('projectId', args.projectId);
      if (args.collectionId) params.set('collectionId', args.collectionId);
      if (args.pageNum !== undefined) params.set('pageNum', String(args.pageNum));
      if (args.pageSize !== undefined) params.set('pageSize', String(args.pageSize));
      const headers: Record<string, string> = {};
      if (args.orgId) headers['x-opus-org-id'] = args.orgId;

      type ClipsResponse =
        | ExportableClipRepresentation[]
        | { data?: ExportableClipRepresentation[]; list?: ExportableClipRepresentation[] };
      const raw = await opusFetch<ClipsResponse>(
        `/api/exportable-clips?${params.toString()}`,
        { headers },
      );
      const clips: ExportableClipRepresentation[] = Array.isArray(raw)
        ? raw
        : (raw.data ?? raw.list ?? []);

      return JSON.stringify(
        {
          ok: true,
          count: clips.length,
          clips: sanitizeList(clips, sanitizeClip, 'opus:get_clips'),
        },
        null,
        2,
      );
    }),
  );

  // ── opus_share_project ────────────────────────────────────────────

  server.registerTool(
    'opus_share_project',
    {
      description:
        'Update the sharing visibility of an OpusClip project. ' +
        '`DEFAULT`: team members can open / edit / export. `PUBLIC`: anyone with the link can open / edit / export.',
      inputSchema: z.object({
        projectId: z.string().min(1),
        visibility: z.enum(SHARE_VISIBILITY).describe('"DEFAULT" or "PUBLIC"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      if (!SHARE_VISIBILITY.includes(args.visibility)) {
        throw new OpusError(
          `Unsupported visibility "${args.visibility}"`,
          'VALIDATION_ERROR',
          `visibility must be one of ${SHARE_VISIBILITY.join(', ')}`,
        );
      }
      const result = await opusFetch<ClipProjectRepresentation>(
        `/api/clip-projects/${encodeURIComponent(args.projectId)}/update-visibility`,
        {
          method: 'POST',
          body: JSON.stringify({ visibility: args.visibility }),
        },
      );
      return JSON.stringify(
        {
          ok: true,
          projectId: result.id ?? result.projectId,
          visibility: args.visibility,
          project: sanitizeProject(result, 'opus:share_project'),
        },
        null,
        2,
      );
    }),
  );
}
