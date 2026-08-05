import type { Client, DriveItem } from '@mindstone/mcp-server-microsoft-shared';
import { z } from 'zod';
import { getAccessToken } from './client.js';
import {
  InvalidOfficeDocumentError,
  extractDocxText,
  extractPptxText,
} from './office-text.js';
import { wrapUntrusted } from './untrusted-content.js';
import { validateUploadSessionUrl } from './upload-url.js';
import { FilesBusinessError } from './types.js';

// ---------------------------------------------------------------------------
// Formatting helpers (ported 1:1 from bundled microsoft-files)
// ---------------------------------------------------------------------------

function formatSize(bytes?: number): string {
  if (!bytes) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatItem(item: DriveItem, sourceTool: string) {
  return {
    id: item.id,
    name: wrapUntrusted(item.name, `microsoft-files:${sourceTool}:name`),
    type: item.folder ? 'folder' : 'file',
    size: formatSize(item.size),
    mimeType: item.file?.mimeType,
    createdAt: item.createdDateTime,
    modifiedAt: item.lastModifiedDateTime,
    webUrl: item.webUrl,
    childCount: item.folder?.childCount,
    path: wrapUntrusted(item.parentReference?.path, `microsoft-files:${sourceTool}:path`),
  };
}

function buildDriveItemEndpoint(path: string, suffix = ''): string {
  if (path.startsWith('/')) {
    return `/me/drive/root:${path}${suffix}`;
  }
  return `/me/drive/items/${path}${suffix}`;
}

/**
 * Fail-closed guard for numeric limits. The tool input schemas already reject
 * non-positive/non-integer values, but these functions are also reachable
 * directly, and an invalid limit must be rejected BEFORE any network call —
 * never discovered indirectly after a fetch.
 */
function assertPositiveIntegerLimit(
  value: number | undefined,
  name: string,
  nextStep: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new FilesBusinessError(
      `"${name}" must be a positive integer. Got: ${String(value)}`,
      nextStep,
    );
  }
}

// Simple PUT /content is capped at 4 MiB by Graph; larger payloads go through
// a resumable upload session. Chunks must be a multiple of 320 KiB.
const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 10 * 320 * 1024;
// Hard cap: content travels base64-encoded inside an MCP tool call, so very
// large binaries belong in the OneDrive UI rather than this connector.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// A regex like /^(?:[A-Za-z0-9+/]{4})*...$/ overflows V8's regexp stack on
// multi-MB inputs, so validate base64 with a plain linear scan instead.
function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isAlphabet =
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) || // 0-9
      code === 43 || // +
      code === 47; // /
    if (isAlphabet) continue;
    // '=' padding only as the final one or two characters
    if (code === 61 && i >= value.length - 2) continue;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Graph response schemas — validate external payloads at the boundary instead
// of casting. `.passthrough()` keeps forward-compatible extra fields.
// ---------------------------------------------------------------------------

const GraphIdentitySchema = z
  .object({
    id: z.string().optional(),
    displayName: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

const GraphPermissionSchema = z
  .object({
    id: z.string(),
    roles: z.array(z.string()).optional(),
    link: z
      .object({
        type: z.string().optional(),
        scope: z.string().optional(),
        webUrl: z.string().optional(),
      })
      .passthrough()
      .optional(),
    grantedToIdentities: z
      .array(z.object({ user: GraphIdentitySchema.optional() }).passthrough())
      .optional(),
    invitation: z.object({ email: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const GraphPermissionListSchema = z
  .object({ value: z.array(GraphPermissionSchema) })
  .passthrough();

const GraphDriveItemVersionSchema = z
  .object({
    id: z.string(),
    lastModifiedDateTime: z.string().optional(),
    size: z.number().optional(),
    lastModifiedBy: z
      .object({ user: GraphIdentitySchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const GraphDriveItemVersionListSchema = z
  .object({ value: z.array(GraphDriveItemVersionSchema) })
  .passthrough();

const GraphItemActivitySchema = z
  .object({
    id: z.string(),
    activityDateTime: z.string().optional(),
    actor: z
      .object({
        user: GraphIdentitySchema.optional(),
        application: GraphIdentitySchema.optional(),
      })
      .passthrough()
      .optional(),
    // v1.0 exposes `access`; older OneDrive payloads carry the legacy
    // itemActionSet under `action`. Both are open bags — presence of a key
    // marks that action type.
    access: z.record(z.unknown()).optional(),
    action: z.record(z.unknown()).optional(),
    driveItem: z
      .object({ id: z.string().optional(), name: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const GraphItemActivityListSchema = z
  .object({ value: z.array(GraphItemActivitySchema) })
  .passthrough();

const GraphUploadedItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    size: z.number().optional(),
    webUrl: z.string().optional(),
  })
  .passthrough();

const GraphUploadSessionSchema = z
  .object({
    uploadUrl: z.string().url(),
    expirationDateTime: z.string().optional(),
  })
  .passthrough();

const GraphDriveItemContentMetadataSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    size: z.number().optional(),
    file: z.object({ mimeType: z.string().optional() }).passthrough().optional(),
    folder: z.object({ childCount: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

function formatActivity(
  activity: z.infer<typeof GraphItemActivitySchema>,
  sourceTool: string,
) {
  const actions = [
    ...Object.keys(activity.action ?? {}),
    ...(activity.access ? ['access'] : []),
  ];
  // Everything here is display-only (no tool takes an activity ID or action
  // name back as an argument), so every vendor-derived string is enveloped —
  // including `action` keys, which are open-ended record keys from the wire.
  return {
    id: wrapUntrusted(activity.id, `microsoft-files:${sourceTool}:id`),
    time: wrapUntrusted(activity.activityDateTime, `microsoft-files:${sourceTool}:time`),
    actor: wrapUntrusted(
      activity.actor?.user?.displayName ?? activity.actor?.application?.displayName,
      `microsoft-files:${sourceTool}:actor`,
    ),
    actions: actions.map((action) =>
      wrapUntrusted(action, `microsoft-files:${sourceTool}:action`),
    ),
    item: activity.driveItem
      ? {
          id: wrapUntrusted(activity.driveItem.id, `microsoft-files:${sourceTool}:itemId`),
          name: wrapUntrusted(
            activity.driveItem.name,
            `microsoft-files:${sourceTool}:item`,
          ),
        }
      : undefined,
  };
}

function formatPermission(
  permission: z.infer<typeof GraphPermissionSchema>,
  sourceTool: string,
) {
  return {
    // Structural, NOT enveloped: permission.id round-trips verbatim as the
    // permissionId argument of revoke_file_permission, and link.webUrl is a
    // functional URL the user opens. Enveloping them would break the flow.
    id: permission.id,
    roles: (permission.roles ?? []).map((role) =>
      wrapUntrusted(role, `microsoft-files:${sourceTool}:role`),
    ),
    link: permission.link
      ? {
          type: wrapUntrusted(permission.link.type, `microsoft-files:${sourceTool}:linkType`),
          scope: wrapUntrusted(permission.link.scope, `microsoft-files:${sourceTool}:linkScope`),
          webUrl: permission.link.webUrl,
        }
      : undefined,
    grantedTo: (permission.grantedToIdentities ?? []).map((identity) => ({
      id: wrapUntrusted(identity.user?.id, `microsoft-files:${sourceTool}:userId`),
      displayName: wrapUntrusted(
        identity.user?.displayName,
        `microsoft-files:${sourceTool}:displayName`,
      ),
      email: wrapUntrusted(identity.user?.email, `microsoft-files:${sourceTool}:email`),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool argument shapes
// ---------------------------------------------------------------------------

export interface ListFilesArgs {
  path?: string;
  top?: number;
}

export interface GetFileArgs {
  path: string;
}

export interface DownloadFileArgs {
  path: string;
}

export interface SearchFilesArgs {
  query: string;
  top?: number;
}

export interface UploadFileArgs {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface CreateFolderArgs {
  path: string;
}

export interface DeleteFileArgs {
  path: string;
}

export interface MoveFileArgs {
  sourcePath: string;
  destinationPath: string;
  newName?: string;
}

export interface CopyFileArgs {
  sourcePath: string;
  destinationPath: string;
  newName?: string;
}

export interface GetRecentArgs {
  top?: number;
}

export interface GetSharedArgs {
  top?: number;
}

export interface ShareFileArgs {
  path: string;
  type?: 'view' | 'edit';
  scope?: 'anonymous' | 'organization';
}

export interface ReadTextFileArgs {
  path: string;
  maxSize?: number;
}

export interface InviteToFileArgs {
  path: string;
  recipients: string[];
  role?: 'read' | 'write';
  message?: string;
  sendInvitation?: boolean;
}

export interface ListFilePermissionsArgs {
  path: string;
}

export interface RevokeFilePermissionArgs {
  path: string;
  permissionId: string;
}

export interface ListFileVersionsArgs {
  path: string;
}

export interface RestoreFileVersionArgs {
  path: string;
  versionId: string;
}

export interface ListFileActivitiesArgs {
  path?: string;
}

export interface ReadDocumentArgs {
  path: string;
  maxSize?: number;
  maxChars?: number;
}

// ---------------------------------------------------------------------------
// Tool functions — 1:1 with the bundled connector. All Graph calls receive
// the composed cancellation signal via `.options({ signal })`.
// ---------------------------------------------------------------------------

export async function listFiles(
  client: Client,
  args: ListFilesArgs,
  signal: AbortSignal,
): Promise<unknown> {
  assertPositiveIntegerLimit(args.top, 'top', 'list_files');
  const top = Math.min(args.top ?? 50, 200);
  let endpoint: string;

  if (args.path) {
    if (args.path.startsWith('/')) {
      endpoint = `/me/drive/root:${args.path}:/children`;
    } else {
      endpoint = `/me/drive/items/${args.path}/children`;
    }
  } else {
    endpoint = '/me/drive/root/children';
  }

  const response = await client
    .api(endpoint)
    .options({ signal })
    .top(top)
    .select('id,name,size,createdDateTime,lastModifiedDateTime,webUrl,folder,file,parentReference')
    .orderby('name')
    .get();

  const items: DriveItem[] = response.value ?? [];

  return {
    count: items.length,
    path: args.path ?? '/',
    items: items.map((item) => formatItem(item, 'list_files')),
  };
}

export async function getFile(
  client: Client,
  args: GetFileArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = buildDriveItemEndpoint(args.path);
  const item = await client
    .api(endpoint)
    .options({ signal })
    .select('id,name,size,createdDateTime,lastModifiedDateTime,webUrl,folder,file,parentReference')
    .get();

  return formatItem(item, 'get_file');
}

export async function downloadFile(
  client: Client,
  args: DownloadFileArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = buildDriveItemEndpoint(args.path);
  const item = await client
    .api(endpoint)
    .options({ signal })
    .select('id,name,@microsoft.graph.downloadUrl')
    .get();

  if (!item['@microsoft.graph.downloadUrl']) {
    throw new FilesBusinessError(
      'Cannot get download URL for this item (may be a folder)',
      'list_files',
    );
  }

  return {
    name: wrapUntrusted(item.name, 'microsoft-files:download_file:name'),
    downloadUrl: item['@microsoft.graph.downloadUrl'],
    note: 'Download URL is valid for a short period',
  };
}

export async function searchFiles(
  client: Client,
  args: SearchFilesArgs,
  signal: AbortSignal,
): Promise<unknown> {
  assertPositiveIntegerLimit(args.top, 'top', 'search_files');
  const top = Math.min(args.top ?? 25, 100);

  const response = await client
    .api(`/me/drive/root/search(q='${encodeURIComponent(args.query)}')`)
    .options({ signal })
    .top(top)
    .select('id,name,size,createdDateTime,lastModifiedDateTime,webUrl,folder,file,parentReference')
    .get();

  const items: DriveItem[] = response.value ?? [];

  return {
    query: args.query,
    count: items.length,
    items: items.map((item) => formatItem(item, 'search_files')),
  };
}

export async function uploadFile(
  client: Client,
  args: UploadFileArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const encoding = args.encoding ?? 'utf8';

  if (encoding === 'base64') {
    if (!isValidBase64(args.content)) {
      throw new FilesBusinessError(
        '"content" is not valid base64. Provide standard base64 (with padding) when encoding is "base64".',
        'upload_file',
      );
    }
    const bytes = Buffer.from(args.content, 'base64');
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new FilesBusinessError(
        `File too large (${formatSize(bytes.length)}). Maximum upload size is ${formatSize(MAX_UPLOAD_BYTES)}.`,
        'upload_file',
      );
    }
    const item =
      bytes.length <= SIMPLE_UPLOAD_MAX_BYTES
        ? GraphUploadedItemSchema.parse(
            await client
              .api(`/me/drive/root:${args.path}:/content`)
              .options({ signal })
              .header('Content-Type', 'application/octet-stream')
              .put(bytes),
          )
        : await uploadViaSession(client, args.path, bytes, signal);
    return formatUploadedItem(item);
  }

  const contentSize = Buffer.byteLength(args.content, 'utf-8');
  if (contentSize > SIMPLE_UPLOAD_MAX_BYTES) {
    throw new FilesBusinessError(
      'File too large. Maximum size is 4MB for text uploads.',
      'upload_file',
    );
  }

  const endpoint = `/me/drive/root:${args.path}:/content`;
  const response = await client
    .api(endpoint)
    .options({ signal })
    .header('Content-Type', 'text/plain')
    .put(args.content);

  return formatUploadedItem(GraphUploadedItemSchema.parse(response));
}

function formatUploadedItem(item: z.infer<typeof GraphUploadedItemSchema>) {
  // `id` doubles as an item path for follow-up calls and `webUrl` is a
  // functional link, so both stay structural (same contract as formatItem).
  return {
    success: true,
    id: item.id,
    name: wrapUntrusted(item.name, 'microsoft-files:upload_file:name'),
    size: formatSize(item.size),
    webUrl: item.webUrl,
    message: 'File uploaded successfully',
  };
}

/**
 * Resumable upload for files larger than the simple-PUT limit. The upload
 * session URL returned by Graph is preauthenticated, so chunk PUTs go out
 * WITHOUT an Authorization header; the shared composed signal still applies.
 */
async function uploadViaSession(
  client: Client,
  path: string,
  bytes: Buffer,
  signal: AbortSignal,
): Promise<z.infer<typeof GraphUploadedItemSchema>> {
  const sessionResponse = await client
    .api(`/me/drive/root:${path}:/createUploadSession`)
    .options({ signal })
    .post({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    });
  const { uploadUrl } = GraphUploadSessionSchema.parse(sessionResponse);
  // The upload URL comes from the upstream response and chunk PUTs carry user
  // file bytes without the bearer token, so the destination is validated
  // against the vendor-host policy before any byte leaves the connector.
  const safeUploadUrl = validateUploadSessionUrl(uploadUrl);

  let item: z.infer<typeof GraphUploadedItemSchema> | null = null;
  for (let start = 0; start < bytes.length; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, bytes.length);
    // Copy into a fresh Uint8Array: Buffer views are typed over
    // ArrayBufferLike, which the DOM BodyInit union rejects.
    const chunk = new Uint8Array(end - start);
    chunk.set(bytes.subarray(start, end));
    const response = await fetch(safeUploadUrl, {
      method: 'PUT',
      // Reject redirects outright: a redirect hop could otherwise retarget
      // the preauthenticated chunk PUT to a non-vendor host.
      redirect: 'error',
      headers: {
        'Content-Length': String(end - start),
        'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}`,
      },
      body: chunk,
      signal,
    });
    if (!response.ok) {
      const err = new Error(`Upload chunk failed: HTTP ${response.status}`) as Error & {
        statusCode?: number;
      };
      err.statusCode = response.status;
      throw err;
    }
    if (response.status === 200 || response.status === 201) {
      item = GraphUploadedItemSchema.parse(await response.json());
    }
  }
  if (!item) {
    throw new FilesBusinessError(
      'Upload session ended without returning the uploaded file.',
      'upload_file',
    );
  }
  return item;
}

export async function createFolder(
  client: Client,
  args: CreateFolderArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const pathParts = args.path.split('/').filter(Boolean);
  const folderName = pathParts.pop();
  const parentPath = '/' + pathParts.join('/');

  if (!folderName) {
    throw new FilesBusinessError('Invalid folder path', 'create_folder');
  }

  let endpoint: string;
  if (parentPath === '/') {
    endpoint = '/me/drive/root/children';
  } else {
    endpoint = `/me/drive/root:${parentPath}:/children`;
  }

  const response = await client.api(endpoint).options({ signal }).post({
    name: folderName,
    folder: {},
    '@microsoft.graph.conflictBehavior': 'fail',
  });

  return {
    success: true,
    id: response.id,
    name: wrapUntrusted(response.name, 'microsoft-files:create_folder:name'),
    webUrl: response.webUrl,
    message: 'Folder created successfully',
  };
}

export async function deleteFile(
  client: Client,
  args: DeleteFileArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = buildDriveItemEndpoint(args.path);
  await client.api(endpoint).options({ signal }).delete();

  return {
    success: true,
    message: 'Item deleted successfully',
  };
}

export async function moveFile(
  client: Client,
  args: MoveFileArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const destEndpoint = args.destinationPath.startsWith('/')
    ? `/me/drive/root:${args.destinationPath}`
    : `/me/drive/items/${args.destinationPath}`;
  const destFolder = await client.api(destEndpoint).options({ signal }).select('id').get();

  const sourceEndpoint = buildDriveItemEndpoint(args.sourcePath);
  const update: Record<string, unknown> = {
    parentReference: { id: destFolder.id },
  };

  if (args.newName) {
    update.name = args.newName;
  }

  const response = await client.api(sourceEndpoint).options({ signal }).patch(update);

  return {
    success: true,
    id: response.id,
    name: wrapUntrusted(response.name, 'microsoft-files:move_file:name'),
    webUrl: response.webUrl,
    message: 'Item moved successfully',
  };
}

export async function copyFile(
  client: Client,
  args: CopyFileArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const sourceEndpoint = buildDriveItemEndpoint(args.sourcePath);
  const sourceItem = await client
    .api(sourceEndpoint)
    .options({ signal })
    .select('id,name')
    .get();

  const destEndpoint = args.destinationPath.startsWith('/')
    ? `/me/drive/root:${args.destinationPath}`
    : `/me/drive/items/${args.destinationPath}`;
  const destFolder = await client.api(destEndpoint).options({ signal }).select('id').get();

  await client.api(`${sourceEndpoint}/copy`).options({ signal }).post({
    parentReference: { id: destFolder.id },
    name: args.newName ?? sourceItem.name,
  });

  return {
    success: true,
    message: 'Copy operation started. File will appear in destination shortly.',
  };
}

export async function getRecent(
  client: Client,
  args: GetRecentArgs,
  signal: AbortSignal,
): Promise<unknown> {
  assertPositiveIntegerLimit(args.top, 'top', 'get_recent');
  const top = Math.min(args.top ?? 25, 100);

  const response = await client
    .api('/me/drive/recent')
    .options({ signal })
    .top(top)
    .select('id,name,size,lastModifiedDateTime,webUrl,folder,file,parentReference')
    .get();

  const items: DriveItem[] = response.value ?? [];

  return {
    count: items.length,
    items: items.map((item) => formatItem(item, 'get_recent')),
  };
}

export async function getShared(
  client: Client,
  args: GetSharedArgs,
  signal: AbortSignal,
): Promise<unknown> {
  assertPositiveIntegerLimit(args.top, 'top', 'get_shared');
  const top = Math.min(args.top ?? 25, 100);

  const response = await client
    .api('/me/drive/sharedWithMe')
    .options({ signal })
    .top(top)
    .select('id,name,size,lastModifiedDateTime,webUrl,folder,file,parentReference')
    .get();

  const items: DriveItem[] = response.value ?? [];

  return {
    count: items.length,
    items: items.map((item) => formatItem(item, 'get_shared')),
  };
}

export async function shareFile(
  client: Client,
  args: ShareFileArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = buildDriveItemEndpoint(args.path, '/createLink');

  const response = await client.api(endpoint).options({ signal }).post({
    type: args.type ?? 'view',
    scope: args.scope ?? 'organization',
  });

  return {
    success: true,
    shareUrl: response.link?.webUrl,
    shareId: response.shareId,
    type: args.type ?? 'view',
    scope: args.scope ?? 'organization',
  };
}

export async function readTextFile(
  client: Client,
  args: ReadTextFileArgs,
  signal: AbortSignal,
): Promise<unknown> {
  assertPositiveIntegerLimit(args.maxSize, 'maxSize', 'read_text_file');
  const maxSize = args.maxSize ?? 100 * 1024;

  const endpoint = buildDriveItemEndpoint(args.path);
  const metadata = await client
    .api(endpoint)
    .options({ signal })
    .select('id,name,size,file,folder')
    .get();

  if (metadata.folder) {
    throw new FilesBusinessError('Cannot read folder contents as text', 'list_files');
  }

  if (metadata.size > maxSize) {
    throw new FilesBusinessError(
      `File too large (${formatSize(metadata.size)}). Max size: ${formatSize(maxSize)}`,
      'read_text_file',
    );
  }

  const mimeType: string = metadata.file?.mimeType ?? '';
  const isText =
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('javascript') ||
    metadata.name.match(/\.(txt|md|json|xml|csv|log|yml|yaml|html|css|js|ts|py|rb|sh|java|c|cpp|h|go|rs)$/i);

  if (!isText) {
    throw new FilesBusinessError(
      `File appears to be binary (${wrapUntrusted(mimeType || 'unknown', 'microsoft-files:read_text_file:mimeType')}). Cannot read as text.`,
      'download_file',
    );
  }

  const contentEndpoint = buildDriveItemEndpoint(args.path, '/content');
  const content = await client.api(contentEndpoint).options({ signal }).get();

  return {
    name: wrapUntrusted(metadata.name, 'microsoft-files:read_text_file:name'),
    size: formatSize(metadata.size),
    mimeType,
    content: wrapUntrusted(
      typeof content === 'string' ? content : content.toString(),
      'microsoft-files:read_text_file:content',
    ),
  };
}

// ---------------------------------------------------------------------------
// Permission management (invite / list / revoke)
// ---------------------------------------------------------------------------

export async function inviteToFile(
  client: Client,
  args: InviteToFileArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = buildDriveItemEndpoint(args.path, '/invite');
  const response = await client
    .api(endpoint)
    .options({ signal })
    .post({
      recipients: args.recipients.map((email) => ({ email })),
      requireSignIn: true,
      sendInvitation: args.sendInvitation ?? false,
      roles: [args.role ?? 'read'],
      ...(args.message ? { message: args.message } : {}),
    });

  const parsed = GraphPermissionListSchema.parse(response);

  return {
    success: true,
    permissions: parsed.value.map((permission) =>
      formatPermission(permission, 'invite_to_file'),
    ),
    message: 'Sharing invitation created',
  };
}

export async function listFilePermissions(
  client: Client,
  args: ListFilePermissionsArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = buildDriveItemEndpoint(args.path, '/permissions');
  const response = await client.api(endpoint).options({ signal }).get();

  const parsed = GraphPermissionListSchema.parse(response);

  return {
    count: parsed.value.length,
    permissions: parsed.value.map((permission) =>
      formatPermission(permission, 'list_file_permissions'),
    ),
  };
}

export async function revokeFilePermission(
  client: Client,
  args: RevokeFilePermissionArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = buildDriveItemEndpoint(
    args.path,
    `/permissions/${encodeURIComponent(args.permissionId)}`,
  );
  await client.api(endpoint).options({ signal }).delete();

  return {
    success: true,
    permissionId: args.permissionId,
    message: 'Permission revoked successfully',
  };
}

// ---------------------------------------------------------------------------
// Version history (list / restore)
// ---------------------------------------------------------------------------

export async function listFileVersions(
  client: Client,
  args: ListFileVersionsArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = buildDriveItemEndpoint(args.path, '/versions');
  const response = await client.api(endpoint).options({ signal }).get();

  const parsed = GraphDriveItemVersionListSchema.parse(response);

  return {
    count: parsed.value.length,
    versions: parsed.value.map((version) => ({
      // Structural, NOT enveloped: version.id round-trips verbatim as the
      // versionId argument of restore_file_version.
      id: version.id,
      modifiedAt: wrapUntrusted(
        version.lastModifiedDateTime,
        'microsoft-files:list_file_versions:modifiedAt',
      ),
      size: formatSize(version.size),
      lastModifiedBy: wrapUntrusted(
        version.lastModifiedBy?.user?.displayName,
        'microsoft-files:list_file_versions:lastModifiedBy',
      ),
    })),
  };
}

export async function restoreFileVersion(
  client: Client,
  args: RestoreFileVersionArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = buildDriveItemEndpoint(
    args.path,
    `/versions/${encodeURIComponent(args.versionId)}/restoreVersion`,
  );
  await client.api(endpoint).options({ signal }).post({});

  return {
    success: true,
    versionId: args.versionId,
    message: 'Version restored successfully. The restored content becomes the current version.',
  };
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export async function listFileActivities(
  client: Client,
  args: ListFileActivitiesArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = args.path
    ? buildDriveItemEndpoint(args.path, '/activities')
    : '/me/drive/activities';
  const response = await client.api(endpoint).options({ signal }).get();

  const parsed = GraphItemActivityListSchema.parse(response);

  return {
    count: parsed.value.length,
    activities: parsed.value.map((activity) =>
      formatActivity(activity, 'list_file_activities'),
    ),
  };
}

// ---------------------------------------------------------------------------
// Document text extraction (docx / pptx)
// ---------------------------------------------------------------------------

// Matches the shared Graph client's defaultVersion (v1.0); raw fetch is only
// used for binary content the SDK cannot hand back as bytes.
const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

const DEFAULT_READ_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_READ_DOCUMENT_MAX_CHARS = 100_000;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function fetchDriveItemBytes(endpoint: string, signal: AbortSignal): Promise<Buffer> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) {
    // statusCode lets withGraphRetry invalidate the cached token and retry on 401.
    const err = new Error(`Graph content request failed: HTTP ${response.status}`) as Error & {
      statusCode?: number;
    };
    err.statusCode = response.status;
    throw err;
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function readDocument(
  client: Client,
  args: ReadDocumentArgs,
  signal: AbortSignal,
): Promise<unknown> {
  assertPositiveIntegerLimit(args.maxSize, 'maxSize', 'read_document');
  assertPositiveIntegerLimit(args.maxChars, 'maxChars', 'read_document');
  const maxSize = args.maxSize ?? DEFAULT_READ_DOCUMENT_MAX_BYTES;
  const maxChars = args.maxChars ?? DEFAULT_READ_DOCUMENT_MAX_CHARS;

  const endpoint = buildDriveItemEndpoint(args.path);
  const metadata = GraphDriveItemContentMetadataSchema.parse(
    await client.api(endpoint).options({ signal }).select('id,name,size,file,folder').get(),
  );

  if (metadata.folder) {
    throw new FilesBusinessError('Cannot read a folder as a document', 'list_files');
  }

  if ((metadata.size ?? 0) > maxSize) {
    throw new FilesBusinessError(
      `File too large (${formatSize(metadata.size)}). Max size: ${formatSize(maxSize)}`,
      'read_document',
    );
  }

  const name = metadata.name ?? '';
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = metadata.file?.mimeType ?? '';
  const isDocx = extension === 'docx' || mimeType === DOCX_MIME;
  const isPptx = extension === 'pptx' || mimeType === PPTX_MIME;

  if (extension === 'pdf' || mimeType === 'application/pdf') {
    throw new FilesBusinessError(
      'PDF text extraction is not supported. Use download_file to get the file instead.',
      'download_file',
    );
  }
  if (!isDocx && !isPptx) {
    // mimeType/extension come from the vendor response; envelope the fragment
    // before interpolating it into a model-visible error message.
    const displayType = wrapUntrusted(
      mimeType || extension || 'unknown',
      'microsoft-files:read_document:mimeType',
    );
    throw new FilesBusinessError(
      `Unsupported document type (${displayType}). read_document supports .docx and .pptx; use read_text_file for plain-text files or download_file otherwise.`,
      'read_text_file',
    );
  }

  const bytes = await fetchDriveItemBytes(buildDriveItemEndpoint(args.path, '/content'), signal);

  let text: string;
  try {
    text = isDocx ? extractDocxText(bytes) : extractPptxText(bytes);
  } catch (err) {
    if (err instanceof InvalidOfficeDocumentError) {
      throw new FilesBusinessError(
        `Could not extract text (${err.message}). The file may be corrupt or not a real Office Open XML document.`,
        'download_file',
      );
    }
    throw err;
  }

  const truncated = text.length > maxChars;
  return {
    name: wrapUntrusted(metadata.name, 'microsoft-files:read_document:name'),
    size: formatSize(metadata.size),
    mimeType,
    truncated,
    content: wrapUntrusted(
      truncated ? text.slice(0, maxChars) : text,
      'microsoft-files:read_document:content',
    ),
  };
}
