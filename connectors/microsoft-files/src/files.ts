import type { Client, DriveItem } from '@mindstone/mcp-server-microsoft-shared';

/**
 * Thrown by files tool functions when a request is rejected by business
 * rules that can only be evaluated AFTER an upstream Graph call (e.g.
 * `read_text_file` rejecting a folder or a binary file).
 *
 * Caught in `tools.ts` and converted into the cohort `{ ok: false, error,
 * action_required, next_step }` recovery-guidance envelope so the host can
 * surface the friendly guidance verbatim.
 */
export class FilesBusinessError extends Error {
  readonly nextStep: string;

  constructor(message: string, nextStep: string) {
    super(message);
    this.name = 'FilesBusinessError';
    this.nextStep = nextStep;
  }
}

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

function formatItem(item: DriveItem) {
  return {
    id: item.id,
    name: item.name,
    type: item.folder ? 'folder' : 'file',
    size: formatSize(item.size),
    mimeType: item.file?.mimeType,
    createdAt: item.createdDateTime,
    modifiedAt: item.lastModifiedDateTime,
    webUrl: item.webUrl,
    childCount: item.folder?.childCount,
    path: item.parentReference?.path,
  };
}

function buildDriveItemEndpoint(path: string, suffix = ''): string {
  if (path.startsWith('/')) {
    return `/me/drive/root:${path}${suffix}`;
  }
  return `/me/drive/items/${path}${suffix}`;
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
    items: items.map(formatItem),
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

  return formatItem(item);
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
    name: item.name,
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
    items: items.map(formatItem),
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
    name: response.name,
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
    name: response.name,
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
    name: response.name,
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
    items: items.map(formatItem),
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
    items: items.map(formatItem),
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
    name: metadata.name,
    size: formatSize(metadata.size),
    mimeType,
    content: typeof content === 'string' ? content : content.toString(),
  };
}
