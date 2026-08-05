import * as fs from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey } from '../auth.js';
import { opusFetch, opusFetchUnauthenticated } from '../client.js';
import { OpusError, getUploadTimeoutMs } from '../types.js';
import { resolveUploadSourcePath } from '../path-safety.js';
import { sanitizeProject } from '../sanitize.js';
import { withErrorHandling } from '../utils.js';
import {
  ConclusionActionSchema,
  CurationPreferenceSchema,
  ImportPreferenceSchema,
  RenderPreferenceSchema,
  UploadedVideoAttrSchema,
} from './projects.js';

/**
 * Cache of completed uploadId → projectId so a network glitch between
 * step 3 (upload complete) and step 4 (create project) doesn't end up
 * creating two billable projects for the same upload — see D9.
 */
const completedProjectByUploadId = new Map<string, unknown>();

interface UploadLinkResponse {
  url: string;
  uploadId: string;
  dnsUrl?: string;
  useAmount?: number;
  totalAmount?: number;
}

interface ClipProjectResponse {
  id?: string;
  projectId?: string;
  stage?: string;
  [key: string]: unknown;
}

/**
 * Issue the resumable-upload "start" POST to GCS and return the
 * `Location` header value (the upload session URL). Empty body,
 * `x-goog-resumable: start`.
 */
async function startResumableSession(initiateUrl: string): Promise<string> {
  const response = (await opusFetchUnauthenticated<Response>(initiateUrl, {
    method: 'POST',
    headers: {
      'x-goog-resumable': 'start',
      'Content-Length': '0',
    },
    uploadTimeout: true,
    rawResponse: true,
  })) as Response;

  if (response.status !== 201 && response.status !== 200) {
    throw new OpusError(
      `GCS resumable-session start returned HTTP ${response.status}`,
      'UPLOAD_FAILED',
      'Re-run opus_upload_video; the upload-link from Step 1 may have expired.',
    );
  }

  const location = response.headers.get('location');
  if (!location) {
    throw new OpusError(
      'GCS resumable-session response missing Location header',
      'UPLOAD_FAILED',
      'Re-run opus_upload_video.',
    );
  }
  return location;
}

/**
 * Query the committed offset for an in-progress GCS resumable upload.
 *
 * Per GCS docs, a `PUT` with `Content-Length: 0` and `Content-Range: bytes
 * STAR/TOTAL` queries how many bytes were already received without
 * uploading more. A `308 Resume Incomplete` response contains a
 * `Range: bytes=0-<lastByte>` header; absence of `Range` means 0 bytes
 * have been committed yet.
 */
async function queryCommittedOffset(sessionUrl: string, totalBytes: number): Promise<number> {
  const response = (await opusFetchUnauthenticated<Response>(sessionUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': '0',
      'Content-Range': `bytes */${totalBytes}`,
    },
    uploadTimeout: true,
    rawResponse: true,
  })) as Response;

  if (response.status === 200 || response.status === 201) {
    return totalBytes;
  }

  if (response.status !== 308) {
    throw new OpusError(
      `GCS committed-offset query returned HTTP ${response.status}`,
      'UPLOAD_RESUMABLE_QUERY_FAILED',
      'The upload session is no longer valid. Re-run opus_upload_video to start over.',
    );
  }

  const rangeHeader = response.headers.get('range');
  if (!rangeHeader) return 0;
  const match = rangeHeader.match(/^bytes=\d+-(\d+)$/);
  if (!match) return 0;
  return Number(match[1]) + 1;
}

/**
 * PUT the bytes of `filePath` starting from `offset` to `sessionUrl` using
 * the standard GCS resumable upload Content-Range format.
 *
 * For simplicity v0.1 streams the whole remaining file in a single request.
 * GCS supports chunked uploads up to 256KB-aligned boundaries; chunking
 * could be added in a future revision, but for files under a few GB on a
 * stable connection a single PUT is the simplest correct path.
 */
async function putUploadBytes(
  sessionUrl: string,
  filePath: string,
  offset: number,
  totalBytes: number,
): Promise<void> {
  const remaining = totalBytes - offset;
  if (remaining <= 0) return;

  const stream = fs.createReadStream(filePath, { start: offset });

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(remaining),
  };
  if (offset > 0) {
    headers['Content-Range'] = `bytes ${offset}-${totalBytes - 1}/${totalBytes}`;
  }

  // `undici`/native fetch on Node 18+ accepts a Node Readable as `body` when
  // `duplex: 'half'` is set. The web RequestInit type doesn't yet model the
  // duplex flag, hence the cast.
  const init = {
    method: 'PUT',
    headers,
    body: stream as unknown as BodyInit,
    duplex: 'half',
    uploadTimeout: true,
    rawResponse: true,
  } as unknown as Parameters<typeof opusFetchUnauthenticated>[1];
  const response = (await opusFetchUnauthenticated<Response>(sessionUrl, init)) as Response;

  if (response.status === 200 || response.status === 201) return;

  if (response.status === 308) {
    // Partial upload accepted; recurse on the committed offset.
    const rangeHeader = response.headers.get('range');
    const m = rangeHeader?.match(/^bytes=\d+-(\d+)$/);
    const committed = m ? Number(m[1]) + 1 : 0;
    if (committed <= offset) {
      throw new OpusError(
        `GCS reported no progress after partial upload (offset=${offset}, committed=${committed})`,
        'UPLOAD_FAILED',
        'Retry the upload with opus_upload_video; the session may be stale.',
      );
    }
    return putUploadBytes(sessionUrl, filePath, committed, totalBytes);
  }

  const errText = await response.text().catch(() => '');
  throw new OpusError(
    `GCS upload PUT returned HTTP ${response.status}: ${errText.slice(0, 200)}`,
    'UPLOAD_FAILED',
    'Retry opus_upload_video. If the failure persists, check that the file is a valid MP4 and under 10GB.',
  );
}

/**
 * Run the 4-step Opus upload flow.
 *
 *  1. POST /api/upload-links               → { url, uploadId }
 *  2. POST <url> with x-goog-resumable=start → session URL via Location header
 *  3. PUT  <session-url> with file bytes   → 200/201
 *  4. POST /api/clip-projects { videoUrl: uploadId, ... } → project
 *
 * Step 4 is idempotent-cached by uploadId so a transient retry after a
 * successful upload doesn't create a second billable project.
 */
async function performUpload(args: {
  filePath: string;
  brandTemplateId?: string;
  curationPref?: z.infer<typeof CurationPreferenceSchema>;
  renderPref?: z.infer<typeof RenderPreferenceSchema>;
  importPref?: z.infer<typeof ImportPreferenceSchema>;
  uploadedVideoAttr?: z.infer<typeof UploadedVideoAttrSchema>;
  conclusionActions?: z.infer<typeof ConclusionActionSchema>[];
}): Promise<{ uploadId: string; project: ClipProjectResponse; resumed: boolean }> {
  const stat = fs.statSync(args.filePath);
  if (!stat.isFile()) {
    throw new OpusError(
      `Not a regular file: ${args.filePath}`,
      'VALIDATION_ERROR',
      'Pass an absolute path to a local video file.',
    );
  }
  const totalBytes = stat.size;
  if (totalBytes <= 0) {
    throw new OpusError(
      `File is empty: ${args.filePath}`,
      'VALIDATION_ERROR',
      'Provide a non-empty video file.',
    );
  }

  // Step 1 — Generate upload link.
  const link = await opusFetch<UploadLinkResponse>('/api/upload-links', {
    method: 'POST',
    body: JSON.stringify({ video: { usecase: 'LocalUpload' } }),
  });
  if (!link.url || !link.uploadId) {
    throw new OpusError(
      'Opus upload-links response missing url/uploadId',
      'UPLOAD_FAILED',
      'The Opus API returned an unexpected response. Retry the request.',
    );
  }

  // Step 2 — Start resumable session.
  const sessionUrl = await startResumableSession(link.url);

  // Step 3 — Upload bytes with offset-query recovery on ambiguous failure.
  let resumed = false;
  try {
    await putUploadBytes(sessionUrl, args.filePath, 0, totalBytes);
  } catch (error) {
    if (error instanceof OpusError) {
      // Treat UPLOAD_FAILED / TIMEOUT / UPLOAD_TIMEOUT as ambiguous: query
      // the committed offset and resume from there. URL_REJECTED /
      // VALIDATION_ERROR / AUTH_* are non-recoverable.
      const recoverable =
        error.code === 'UPLOAD_FAILED' ||
        error.code === 'UPLOAD_TIMEOUT' ||
        error.code === 'TIMEOUT' ||
        error.code === 'API_ERROR';
      if (!recoverable) throw error;
    } else if (!(error instanceof Error)) {
      throw error;
    }
    const committed = await queryCommittedOffset(sessionUrl, totalBytes);
    if (committed < totalBytes) {
      resumed = true;
      await putUploadBytes(sessionUrl, args.filePath, committed, totalBytes);
    } else {
      // Server already has all the bytes — surface as resumed for visibility.
      resumed = true;
    }
  }

  // Step 4 — Create clip project (idempotent on uploadId).
  if (completedProjectByUploadId.has(link.uploadId)) {
    const cached = completedProjectByUploadId.get(link.uploadId) as ClipProjectResponse;
    return { uploadId: link.uploadId, project: cached, resumed };
  }
  const projectBody: Record<string, unknown> = {
    videoUrl: link.uploadId,
  };
  if (args.brandTemplateId) projectBody.brandTemplateId = args.brandTemplateId;
  if (args.curationPref) projectBody.curationPref = args.curationPref;
  if (args.renderPref) projectBody.renderPref = args.renderPref;
  if (args.importPref) projectBody.importPref = args.importPref;
  if (args.uploadedVideoAttr) projectBody.uploadedVideoAttr = args.uploadedVideoAttr;
  if (args.conclusionActions) projectBody.conclusionActions = args.conclusionActions;

  const project = await opusFetch<ClipProjectResponse>('/api/clip-projects', {
    method: 'POST',
    body: JSON.stringify(projectBody),
  });

  completedProjectByUploadId.set(link.uploadId, project);
  return { uploadId: link.uploadId, project, resumed };
}

export function registerUploadTools(server: McpServer): void {
  server.registerTool(
    'opus_upload_video',
    {
      description:
        'Upload a local video file to OpusClip and create a clipping project in a single step. ' +
        'Orchestrates the 4-step Opus / Google Cloud Storage resumable upload: (1) request an upload link, (2) start a GCS resumable session, (3) PUT the video bytes (with automatic offset-query recovery on ambiguous failures), (4) create the project. ' +
        'Pass `file_path` as an absolute filesystem path. Optional `brandTemplateId`, `curationPref`, `renderPref`, `importPref`, `uploadedVideoAttr`, and `conclusionActions` are forwarded to `opus_create_project`. ' +
        'On retryable network failures the same `uploadId` is reused, so calling this tool twice in a row will NOT create two billable projects. ' +
        `Per-chunk upload timeout is OPUS_UPLOAD_TIMEOUT_MS (default ${Math.round(getUploadTimeoutMs() / 1000)}s).`,
      inputSchema: z.object({
        file_path: z
          .string()
          .min(1)
          .describe(
            'Absolute path to a local video file (MP4 recommended, up to 10GB). ' +
              'The file MUST live inside the workspace sandbox: MCP_WORKSPACE_PATH when set, otherwise the system temp directory. Paths outside the sandbox are refused.',
          ),
        brandTemplateId: z.string().optional(),
        curationPref: CurationPreferenceSchema.optional(),
        renderPref: RenderPreferenceSchema.optional(),
        importPref: ImportPreferenceSchema.optional(),
        uploadedVideoAttr: UploadedVideoAttrSchema.optional(),
        conclusionActions: z.array(ConclusionActionSchema).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      // Invariant #5 — confine reads to MCP_WORKSPACE_PATH / os.tmpdir().
      // Throws a structured OpusError (PATH_OUTSIDE_WORKSPACE) on any path
      // outside the sandbox, including symlink escapes, before any byte is read.
      const filePath = resolveUploadSourcePath(args.file_path);
      const result = await performUpload({
        filePath,
        brandTemplateId: args.brandTemplateId,
        curationPref: args.curationPref,
        renderPref: args.renderPref,
        importPref: args.importPref,
        uploadedVideoAttr: args.uploadedVideoAttr,
        conclusionActions: args.conclusionActions,
      });
      return JSON.stringify(
        {
          ok: true,
          uploadId: result.uploadId,
          projectId: result.project.id ?? result.project.projectId,
          resumed: result.resumed,
          message:
            'Video uploaded and clip project created. Poll opus_get_project with this projectId until stage="COMPLETE", then call opus_get_clips.',
          project: sanitizeProject(result.project, 'opus:upload_video'),
        },
        null,
        2,
      );
    }),
  );
}
