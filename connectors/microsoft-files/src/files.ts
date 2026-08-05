import type { Client, DriveItem } from '@mindstone/mcp-server-microsoft-shared';
import { z } from 'zod';
import { wrapUntrusted } from './untrusted-content.js';
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

function formatPermission(
  permission: z.infer<typeof GraphPermissionSchema>,
  sourceTool: string,
) {
  return {
    id: permission.id,
    roles: permission.roles ?? [],
    link: permission.link
      ? {
          type: permission.link.type,
          scope: permission.link.scope,
          webUrl: permission.link.webUrl,
        }
      : undefined,
    grantedTo: (permission.grantedToIdentities ?? []).map((identity) => ({
      id: identity.user?.id,
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

// ---------------------------------------------------------------------------
// Tool functions — 1:1 with the bundled connector. All Graph calls receive
// the composed cancellation signal via `.options({ signal })`.
// ---------------------------------------------------------------------------

export async function listFiles(
  client: Client,
  args: ListFilesArgs,
  signal: AbortSignal,
): Promise<unknown> {
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
  const contentSize = Buffer.byteLength(args.content, 'utf-8');
  if (contentSize > 4 * 1024 * 1024) {
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

  return {
    success: true,
    id: response.id,
    name: wrapUntrusted(response.name, 'microsoft-files:upload_file:name'),
    size: formatSize(response.size),
    webUrl: response.webUrl,
    message: 'File uploaded successfully',
  };
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
      `File appears to be binary (${mimeType}). Cannot read as text.`,
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
