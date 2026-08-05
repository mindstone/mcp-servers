import {
  successResult,
  errorResult,
  type ToolResult,
  type DriveItem,
  type SharePointSite,
  type SharePointDrive,
  type Client,
} from '@mindstone/mcp-server-microsoft-shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

// -- Graph response schemas (Zod-validated at the boundary for new tools) --

/** Parse a Graph collection response (`{ value: [...] }`) against an item schema. */
function parseGraphCollection<S extends z.ZodTypeAny>(itemSchema: S, response: unknown): z.infer<S>[] {
  return z.object({ value: z.array(itemSchema) }).parse(response).value;
}

const GraphIdentitySchema = z.object({
  displayName: z.string().optional(),
  email: z.string().optional(),
});

const GraphIdentitySetSchema = z.object({
  user: GraphIdentitySchema.optional(),
  siteUser: GraphIdentitySchema.optional(),
  group: GraphIdentitySchema.optional(),
  siteGroup: GraphIdentitySchema.optional(),
  application: GraphIdentitySchema.optional(),
});

const GraphPermissionSchema = z.object({
  id: z.string(),
  roles: z.array(z.string()).optional().default([]),
  shareId: z.string().optional(),
  link: z
    .object({
      type: z.string().optional(),
      scope: z.string().optional(),
      webUrl: z.string().optional(),
    })
    .optional(),
  grantedToV2: GraphIdentitySetSchema.optional(),
  grantedToIdentitiesV2: z.array(GraphIdentitySetSchema).optional(),
});

type GraphPermission = z.infer<typeof GraphPermissionSchema>;
type GraphIdentity = z.infer<typeof GraphIdentitySchema>;

const GraphDriveItemVersionSchema = z.object({
  id: z.string(),
  size: z.number().optional(),
  lastModifiedDateTime: z.string().optional(),
  lastModifiedBy: z
    .object({
      user: GraphIdentitySchema.optional(),
    })
    .optional(),
});

/** columnDefinition facet keys that determine a column's type. */
const COLUMN_TYPE_FACETS = [
  'boolean',
  'calculated',
  'choice',
  'currency',
  'dateTime',
  'geolocation',
  'hyperlinkOrPicture',
  'lookup',
  'number',
  'personOrGroup',
  'text',
  'term',
  'thumbnail',
] as const;

const GraphColumnDefinitionSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    hidden: z.boolean().optional(),
    readOnly: z.boolean().optional(),
  })
  .catchall(z.unknown());

const GraphListSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  webUrl: z.string().optional(),
  list: z
    .object({
      template: z.string().optional(),
      hidden: z.boolean().optional(),
    })
    .optional(),
});

const GraphUploadSessionSchema = z.object({
  uploadUrl: z.string(),
});

const GraphUploadedItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  webUrl: z.string().optional(),
});

const GraphSitePageSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  webUrl: z.string().optional(),
  pageLayout: z.string().optional(),
  promotionKind: z.string().optional(),
  publishingState: z
    .object({
      level: z.string().optional(),
      versionId: z.string().optional(),
    })
    .optional(),
});

function extractPermissionIdentities(permission: GraphPermission): GraphIdentity[] {
  const sets = [
    ...(permission.grantedToV2 ? [permission.grantedToV2] : []),
    ...(permission.grantedToIdentitiesV2 ?? []),
  ];
  const identities: GraphIdentity[] = [];
  for (const set of sets) {
    const identity = set.user ?? set.siteUser ?? set.group ?? set.siteGroup ?? set.application;
    if (identity) identities.push(identity);
  }
  return identities;
}

function formatPermission(permission: GraphPermission, sourceTool: string) {
  return {
    id: permission.id,
    roles: permission.roles,
    shareId: permission.shareId,
    link: permission.link,
    grantedTo: extractPermissionIdentities(permission).map((identity) => ({
      displayName: wrapUntrusted(identity.displayName, `microsoft-sharepoint:${sourceTool}:displayName`),
      email: identity.email,
    })),
  };
}

// -- Helpers --

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
    name: wrapUntrusted(item.name, `microsoft-sharepoint:${sourceTool}:name`),
    type: item.folder ? 'folder' : 'file',
    size: formatSize(item.size),
    mimeType: item.file?.mimeType,
    createdAt: item.createdDateTime,
    modifiedAt: item.lastModifiedDateTime,
    webUrl: item.webUrl,
    childCount: item.folder?.childCount,
    path: wrapUntrusted(item.parentReference?.path, `microsoft-sharepoint:${sourceTool}:path`),
  };
}

function formatSite(site: SharePointSite, sourceTool: string) {
  return {
    id: site.id,
    displayName: wrapUntrusted(site.displayName, `microsoft-sharepoint:${sourceTool}:displayName`),
    name: wrapUntrusted(site.name, `microsoft-sharepoint:${sourceTool}:name`),
    webUrl: site.webUrl,
    description: wrapUntrusted(site.description, `microsoft-sharepoint:${sourceTool}:description`),
    createdAt: site.createdDateTime,
    modifiedAt: site.lastModifiedDateTime,
    hostname: wrapUntrusted(site.siteCollection?.hostname, `microsoft-sharepoint:${sourceTool}:hostname`),
    isRoot: !!site.root,
  };
}

function formatDrive(drive: SharePointDrive, sourceTool: string) {
  return {
    id: drive.id,
    name: wrapUntrusted(drive.name, `microsoft-sharepoint:${sourceTool}:name`),
    description: wrapUntrusted(drive.description, `microsoft-sharepoint:${sourceTool}:description`),
    driveType: drive.driveType,
    webUrl: drive.webUrl,
    createdAt: drive.createdDateTime,
    modifiedAt: drive.lastModifiedDateTime,
    quota: drive.quota ? {
      total: formatSize(drive.quota.total),
      used: formatSize(drive.quota.used),
      remaining: formatSize(drive.quota.remaining),
      state: drive.quota.state,
    } : undefined,
  };
}

function buildDriveEndpoint(driveId: string, itemId: string): string {
  return `/drives/${driveId}/items/${itemId}`;
}

function encodeDrivePath(path: string): string {
  const trimmedPath = path.trim().replace(/^\/+/u, '').replace(/\/+$/u, '');
  if (!trimmedPath) {
    return '';
  }
  return trimmedPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

// -- Tool implementations --

interface ListSharePointSitesArgs {
  query?: string;
  top?: number;
}

export async function listSharePointSites(
  client: Client,
  args: ListSharePointSitesArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  const top = Math.min(args.top ?? 25, 100);
  const query = args.query || '*';

  const response = await client
    .api(`/sites?search=${encodeURIComponent(query)}`)
    .options({ signal })
    .top(top)
    .select('id,displayName,name,webUrl,description,createdDateTime,lastModifiedDateTime,root,siteCollection')
    .get();

  const sites: SharePointSite[] = response.value ?? [];

  return successResult({
    query: args.query || '(all sites)',
    count: sites.length,
    sites: sites.map((site) => formatSite(site, 'list_sharepoint_sites')),
  });
}

interface GetSharePointSiteArgs {
  siteId?: string;
}

export async function getSharePointSite(
  client: Client,
  args: GetSharePointSiteArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId) {
    return errorResult(
      'Missing required parameter: "siteId" (SharePoint site ID or hostname path). ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456" } or { "siteId": "contoso.sharepoint.com:/sites/Marketing" }. ' +
      'Use list_sharepoint_sites to find sites.',
    );
  }

  const site = await client
    .api(`/sites/${args.siteId}`)
    .options({ signal })
    .select('id,displayName,name,webUrl,description,createdDateTime,lastModifiedDateTime,root,siteCollection')
    .get();

  return successResult(formatSite(site, 'get_sharepoint_site'));
}

interface ListSiteDocumentLibrariesArgs {
  siteId?: string;
  top?: number;
}

export async function listSiteDocumentLibraries(
  client: Client,
  args: ListSiteDocumentLibrariesArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId) {
    return errorResult(
      'Missing required parameter: "siteId" (SharePoint site ID). ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456" }. ' +
      'Use list_sharepoint_sites to find sites first.',
    );
  }

  const top = Math.min(args.top ?? 50, 200);

  const response = await client
    .api(`/sites/${args.siteId}/drives`)
    .options({ signal })
    .top(top)
    .select('id,name,description,driveType,webUrl,createdDateTime,lastModifiedDateTime,quota')
    .get();

  const drives: SharePointDrive[] = response.value ?? [];

  return successResult({
    siteId: args.siteId,
    count: drives.length,
    documentLibraries: drives.map((drive) => formatDrive(drive, 'list_site_document_libraries')),
  });
}

interface ListLibraryFilesArgs {
  driveId?: string;
  path?: string;
  top?: number;
}

export async function listLibraryFiles(
  client: Client,
  args: ListLibraryFilesArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId) {
    return errorResult(
      'Missing required parameter: "driveId" (document library ID). ' +
      'Example: { "driveId": "b!abc123..." }. ' +
      'Use list_site_document_libraries to find document libraries first.',
    );
  }

  const top = Math.min(args.top ?? 50, 200);
  let endpoint: string;

  if (args.path) {
    const encodedPath = encodeDrivePath(args.path);
    endpoint = encodedPath
      ? `/drives/${args.driveId}/root:/${encodedPath}:/children`
      : `/drives/${args.driveId}/root/children`;
  } else {
    endpoint = `/drives/${args.driveId}/root/children`;
  }

  const response = await client
    .api(endpoint)
    .options({ signal })
    .top(top)
    .select('id,name,size,createdDateTime,lastModifiedDateTime,webUrl,folder,file,parentReference')
    .orderby('name')
    .get();

  const items: DriveItem[] = response.value ?? [];

  return successResult({
    driveId: args.driveId,
    path: args.path ?? '/',
    count: items.length,
    items: items.map((item) => formatItem(item, 'list_library_files')),
  });
}

interface GetLibraryFileArgs {
  driveId?: string;
  itemId?: string;
}

export async function getLibraryFile(
  client: Client,
  args: GetLibraryFileArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "driveId" (document library ID) and "itemId" (file/folder ID). ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF..." }. ' +
      'Use list_library_files to browse files.',
    );
  }

  const endpoint = buildDriveEndpoint(args.driveId, args.itemId);
  const item = await client
    .api(endpoint)
    .options({ signal })
    .select('id,name,size,createdDateTime,lastModifiedDateTime,webUrl,folder,file,parentReference')
    .get();

  return successResult(formatItem(item, 'get_library_file'));
}

interface DownloadLibraryFileArgs {
  driveId?: string;
  itemId?: string;
}

export async function downloadLibraryFile(
  client: Client,
  args: DownloadLibraryFileArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "driveId" (document library ID) and "itemId" (file ID). ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF..." }. ' +
      'Returns a temporary download URL.',
    );
  }

  const endpoint = buildDriveEndpoint(args.driveId, args.itemId);
  const item = await client.api(endpoint).options({ signal }).get();

  if (!item['@microsoft.graph.downloadUrl']) {
    return errorResult('Cannot get download URL for this item (may be a folder)');
  }

  return successResult({
    name: wrapUntrusted(item.name, 'microsoft-sharepoint:download_library_file:name'),
    downloadUrl: item['@microsoft.graph.downloadUrl'],
    note: 'Download URL is valid for a short period',
  });
}

interface SearchLibraryFilesArgs {
  driveId?: string;
  query?: string;
  top?: number;
}

export async function searchLibraryFiles(
  client: Client,
  args: SearchLibraryFilesArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.query) {
    return errorResult(
      'Missing required parameters: "driveId" (document library ID) and "query" (search text). ' +
      'Example: { "driveId": "b!abc123...", "query": "quarterly report", "top": 20 }',
    );
  }

  const top = Math.min(args.top ?? 25, 100);
  // Escape single quotes for OData query syntax
  const escapedQuery = args.query.replace(/'/g, "''");

  const response = await client
    .api(`/drives/${args.driveId}/root/search(q='${escapedQuery}')`)
    .options({ signal })
    .top(top)
    .select('id,name,size,createdDateTime,lastModifiedDateTime,webUrl,folder,file,parentReference')
    .get();

  const items: DriveItem[] = response.value ?? [];

  return successResult({
    driveId: args.driveId,
    query: args.query,
    count: items.length,
    items: items.map((item) => formatItem(item, 'search_library_files')),
  });
}

interface ReadLibraryTextFileArgs {
  driveId?: string;
  itemId?: string;
  maxSize?: number;
}

export async function readLibraryTextFile(
  client: Client,
  args: ReadLibraryTextFileArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "driveId" (document library ID) and "itemId" (file ID). ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF...", "maxSize": 102400 }. ' +
      'Only works with text files (txt, md, json, etc.).',
    );
  }

  const maxSize = args.maxSize ?? 100 * 1024; // 100KB default

  // Get file metadata first to check size and type
  const endpoint = buildDriveEndpoint(args.driveId, args.itemId);
  const metadata = await client
    .api(endpoint)
    .options({ signal })
    .select('id,name,size,file')
    .get();

  if (metadata.folder) {
    return errorResult('Cannot read folder contents as text');
  }

  if (metadata.size > maxSize) {
    return errorResult(`File too large (${formatSize(metadata.size)}). Max size: ${formatSize(maxSize)}`);
  }

  // Check if it's likely a text file
  const mimeType = metadata.file?.mimeType ?? '';
  const isText = mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('javascript') ||
    metadata.name.match(/\.(txt|md|json|xml|csv|log|yml|yaml|html|css|js|ts|py|rb|sh|java|c|cpp|h|go|rs)$/i);

  if (!isText) {
    return errorResult(`File appears to be binary (${mimeType}). Cannot read as text.`);
  }

  // Download content via /content endpoint (returns file bytes directly)
  const contentEndpoint = `/drives/${args.driveId}/items/${args.itemId}/content`;
  const rawContent = await client.api(contentEndpoint).options({ signal }).get();
  let content = typeof rawContent === 'string' ? rawContent : rawContent.toString();

  // Truncate if needed
  if (content.length > maxSize) {
    content = content.substring(0, maxSize) + '\n... (truncated)';
  }

  return successResult({
    name: wrapUntrusted(metadata.name, 'microsoft-sharepoint:read_library_text_file:name'),
    size: formatSize(metadata.size),
    mimeType,
    content: wrapUntrusted(content, 'microsoft-sharepoint:read_library_text_file:content'),
  });
}

// -- Write tool implementations --

interface UploadLibraryFileArgs {
  driveId?: string;
  path?: string;
  content?: string;
}

export async function uploadLibraryFile(
  client: Client,
  args: UploadLibraryFileArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.path || !args.content) {
    return errorResult(
      'Missing required parameters: "driveId", "path" (destination path), and "content" (file content). ' +
      'Example: { "driveId": "b!abc123...", "path": "General/notes.txt", "content": "File content here..." }',
    );
  }

  const contentSize = Buffer.byteLength(args.content, 'utf-8');
  if (contentSize > 50 * 1024 * 1024) {
    return errorResult('File too large. Maximum size is 50MB for simple uploads via this tool.');
  }

  const encodedPath = encodeDrivePath(args.path);
  const endpoint = `/drives/${args.driveId}/root:/${encodedPath}:/content`;
  const response = await client
    .api(endpoint)
    .options({ signal })
    .header('Content-Type', 'text/plain')
    .put(args.content);

  return successResult({
    success: true,
    id: response.id,
    name: wrapUntrusted(response.name, 'microsoft-sharepoint:upload_library_file:name'),
    size: formatSize(response.size),
    webUrl: response.webUrl,
    message: 'File uploaded successfully',
  });
}

// -- Large/binary upload tool implementation --

/** Graph requires every chunk except the last to be a multiple of 320 KiB. */
const UPLOAD_CHUNK_SIZE = 10 * 320 * 1024;
const MAX_UPLOAD_SESSION_BYTES = 100 * 1024 * 1024;

interface UploadLibraryFileBinaryArgs {
  driveId?: string;
  path?: string;
  contentBase64?: string;
  conflictBehavior?: 'fail' | 'rename' | 'replace';
}

export async function uploadLibraryFileBinary(
  client: Client,
  args: UploadLibraryFileBinaryArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.path || !args.contentBase64) {
    return errorResult(
      'Missing required parameters: "driveId", "path" (destination path), and "contentBase64" (base64-encoded file content). ' +
      'Example: { "driveId": "b!abc123...", "path": "General/report.pdf", "contentBase64": "JVBERi0x..." }',
    );
  }

  const base64 = args.contentBase64.replace(/\s+/g, '');
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return errorResult('The "contentBase64" parameter is not valid base64.');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    return errorResult('The decoded content is empty.');
  }
  if (buffer.length > MAX_UPLOAD_SESSION_BYTES) {
    return errorResult(
      `File too large (${formatSize(buffer.length)}). Max size: ${formatSize(MAX_UPLOAD_SESSION_BYTES)}.`,
    );
  }

  const encodedPath = encodeDrivePath(args.path);
  const sessionResponse = await client
    .api(`/drives/${args.driveId}/root:/${encodedPath}:/createUploadSession`)
    .options({ signal })
    .post({
      item: {
        // Default to "rename" so an upload never silently clobbers an existing file.
        '@microsoft.graph.conflictBehavior': args.conflictBehavior ?? 'rename',
      },
    });
  const { uploadUrl } = GraphUploadSessionSchema.parse(sessionResponse);

  // The uploadUrl is pre-authenticated by Graph; chunks go to it directly
  // without an Authorization header.
  let start = 0;
  let uploaded: z.infer<typeof GraphUploadedItemSchema> | null = null;
  while (start < buffer.length) {
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, buffer.length);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(end - start),
        'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}`,
      },
      body: new Uint8Array(buffer.subarray(start, end)),
      signal,
    });

    if (response.status === 202) {
      start = end;
      continue;
    }
    if (response.status === 200 || response.status === 201) {
      uploaded = GraphUploadedItemSchema.parse(await response.json());
      break;
    }
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Upload session failed with HTTP ${response.status}` +
      (errorBody ? `: ${errorBody.slice(0, 500)}` : ''),
    );
  }

  if (!uploaded) {
    throw new Error('Upload session ended without a completed item');
  }

  return successResult({
    success: true,
    id: uploaded.id,
    name: wrapUntrusted(uploaded.name, 'microsoft-sharepoint:upload_library_file_binary:name'),
    size: formatSize(uploaded.size ?? buffer.length),
    webUrl: uploaded.webUrl,
    message: 'File uploaded successfully',
  });
}

interface CreateLibraryFolderArgs {
  driveId?: string;
  path?: string;
}

export async function createLibraryFolder(
  client: Client,
  args: CreateLibraryFolderArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.path) {
    return errorResult(
      'Missing required parameters: "driveId" and "path" (folder path to create). ' +
      'Example: { "driveId": "b!abc123...", "path": "General/ProjectFiles" }',
    );
  }

  const pathParts = args.path.split('/').filter(Boolean);
  const folderName = pathParts.pop();
  const parentPath = pathParts.join('/');

  if (!folderName) {
    return errorResult('Invalid folder path');
  }

  let endpoint: string;
  if (!parentPath) {
    endpoint = `/drives/${args.driveId}/root/children`;
  } else {
    const encodedParent = encodeDrivePath(parentPath);
    endpoint = `/drives/${args.driveId}/root:/${encodedParent}:/children`;
  }

  const response = await client.api(endpoint).options({ signal }).post({
    name: folderName,
    folder: {},
    '@microsoft.graph.conflictBehavior': 'fail',
  });

  return successResult({
    success: true,
    id: response.id,
    name: wrapUntrusted(response.name, 'microsoft-sharepoint:create_library_folder:name'),
    webUrl: response.webUrl,
    message: 'Folder created successfully',
  });
}

interface DeleteLibraryItemArgs {
  driveId?: string;
  itemId?: string;
}

export async function deleteLibraryItem(
  client: Client,
  args: DeleteLibraryItemArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "driveId" and "itemId" (file/folder to delete). ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF..." }. ' +
      'WARNING: This permanently deletes the item.',
    );
  }

  const endpoint = buildDriveEndpoint(args.driveId, args.itemId);
  await client.api(endpoint).options({ signal }).delete();

  return successResult({
    success: true,
    message: 'Item deleted successfully',
  });
}

interface MoveLibraryItemArgs {
  driveId?: string;
  itemId?: string;
  destinationDriveId?: string;
  destinationFolderId?: string;
  newName?: string;
}

export async function moveLibraryItem(
  client: Client,
  args: MoveLibraryItemArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId || !args.destinationFolderId) {
    return errorResult(
      'Missing required parameters: "driveId", "itemId", and "destinationFolderId". ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF...", "destinationFolderId": "01XYZ789..." }',
    );
  }

  if (args.destinationDriveId && args.destinationDriveId !== args.driveId) {
    return errorResult(
      'Cannot move items between different drives/libraries. ' +
      'Use copy_library_item + delete_library_item instead for cross-library moves.',
    );
  }

  const endpoint = buildDriveEndpoint(args.driveId, args.itemId);
  const update: Record<string, unknown> = {
    parentReference: {
      id: args.destinationFolderId,
    },
  };

  if (args.newName) {
    update.name = args.newName;
  }

  const response = await client.api(endpoint).options({ signal }).patch(update);

  return successResult({
    success: true,
    id: response.id,
    name: wrapUntrusted(response.name, 'microsoft-sharepoint:move_library_item:name'),
    webUrl: response.webUrl,
    message: 'Item moved successfully',
  });
}

interface CopyLibraryItemArgs {
  driveId?: string;
  itemId?: string;
  destinationDriveId?: string;
  destinationFolderId?: string;
  newName?: string;
}

export async function copyLibraryItem(
  client: Client,
  args: CopyLibraryItemArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId || !args.destinationFolderId) {
    return errorResult(
      'Missing required parameters: "driveId", "itemId", and "destinationFolderId". ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF...", "destinationFolderId": "01XYZ789...", "newName": "copy.docx" }',
    );
  }

  const sourceEndpoint = buildDriveEndpoint(args.driveId, args.itemId);
  const sourceItem = await client.api(sourceEndpoint).options({ signal }).select('id,name').get();

  await client.api(`${sourceEndpoint}/copy`).options({ signal }).post({
    parentReference: {
      driveId: args.destinationDriveId ?? args.driveId,
      id: args.destinationFolderId,
    },
    name: args.newName ?? sourceItem.name,
  });

  return successResult({
    success: true,
    message: 'Copy operation started. File will appear in destination shortly.',
  });
}

// -- Site Pages tool implementations --

interface ListSitePagesArgs {
  siteId?: string;
  top?: number;
}

export async function listSitePages(
  client: Client,
  args: ListSitePagesArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId) {
    return errorResult(
      'Missing required parameter: "siteId" (SharePoint site ID). ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456" }. ' +
      'Use list_sharepoint_sites to find sites first.',
    );
  }

  const top = Math.min(args.top ?? 25, 100);

  const response = await client
    .api(`/sites/${args.siteId}/pages`)
    .options({ signal })
    .top(top)
    .select('id,title,name,webUrl,description,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy')
    .orderby('lastModifiedDateTime desc')
    .get();

  const pages = (response.value ?? []).map((page: Record<string, unknown>) => ({
    id: page.id,
    title: wrapUntrusted(
      typeof page.title === 'string' ? page.title : undefined,
      'microsoft-sharepoint:list_site_pages:title',
    ),
    name: wrapUntrusted(
      typeof page.name === 'string' ? page.name : undefined,
      'microsoft-sharepoint:list_site_pages:name',
    ),
    webUrl: page.webUrl,
    description: wrapUntrusted(
      typeof page.description === 'string' ? page.description : undefined,
      'microsoft-sharepoint:list_site_pages:description',
    ),
    createdAt: page.createdDateTime,
    modifiedAt: page.lastModifiedDateTime,
    createdBy: (page.createdBy as Record<string, unknown>)?.user
      ? wrapUntrusted(
        (page.createdBy as Record<string, Record<string, string>>).user.displayName,
        'microsoft-sharepoint:list_site_pages:createdBy',
      )
      : undefined,
    lastModifiedBy: (page.lastModifiedBy as Record<string, unknown>)?.user
      ? wrapUntrusted(
        (page.lastModifiedBy as Record<string, Record<string, string>>).user.displayName,
        'microsoft-sharepoint:list_site_pages:lastModifiedBy',
      )
      : undefined,
  }));

  return successResult({
    siteId: args.siteId,
    count: pages.length,
    pages,
  });
}

interface ReadSitePageArgs {
  siteId?: string;
  pageId?: string;
}

export async function readSitePage(
  client: Client,
  args: ReadSitePageArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.pageId) {
    return errorResult(
      'Missing required parameters: "siteId" and "pageId". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "pageId": "abc123" }. ' +
      'Use list_site_pages to find pages first.',
    );
  }

  // The /microsoft.graph.sitePage type cast is required for page-specific APIs
  const pageBase = `/sites/${args.siteId}/pages/${args.pageId}/microsoft.graph.sitePage`;

  // Get page metadata
  const page = await client
    .api(pageBase)
    .options({ signal })
    .select('id,title,name,webUrl,description,createdDateTime,lastModifiedDateTime,pageLayout')
    .get();

  // Use the flat /webParts endpoint — returns all webparts in page order
  // regardless of layout structure (more reliable than $expand=canvasLayout
  // which requires deep expansion of sections/columns/webparts relationships)
  const contentParts: string[] = [];
  let contentWarning: string | undefined;
  try {
    const webPartsResponse = await client
      .api(`${pageBase}/webParts`)
      .options({ signal })
      .get();

    for (const wp of webPartsResponse.value ?? []) {
      if (wp.innerHtml) {
        contentParts.push(wp.innerHtml);
      } else if (wp.data?.properties?.description) {
        contentParts.push(wp.data.properties.description);
      }
    }
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const message = err instanceof Error ? err.message.toLowerCase() : '';
    const isLikelyUnsupportedPageType =
      statusCode === 400 ||
      statusCode === 404 ||
      message.includes('webpart') ||
      message.includes('not supported') ||
      message.includes('resource not found');

    if (!isLikelyUnsupportedPageType) {
      throw err;
    }

    contentWarning =
      'Page body webparts could not be retrieved (page type may not expose webparts via Graph).';
  }

  return successResult({
    id: page.id,
    title: wrapUntrusted(page.title, 'microsoft-sharepoint:read_site_page:title'),
    name: wrapUntrusted(page.name, 'microsoft-sharepoint:read_site_page:name'),
    webUrl: page.webUrl,
    description: wrapUntrusted(page.description, 'microsoft-sharepoint:read_site_page:description'),
    pageLayout: page.pageLayout,
    createdAt: page.createdDateTime,
    modifiedAt: page.lastModifiedDateTime,
    contentHtml: contentParts.length > 0
      ? wrapUntrusted(contentParts.join('\n\n'), 'microsoft-sharepoint:read_site_page:contentHtml')
      : '(no text content found — page may be empty or use non-text web parts)',
    ...(contentWarning ? { contentWarning } : {}),
  });
}

// -- Site page authoring tool implementations --

function derivePageName(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'page'}.aspx`;
}

/** Single-section, single-column canvas layout holding one text web part. */
function buildTextCanvasLayout(contentHtml: string): Record<string, unknown> {
  return {
    horizontalSections: [
      {
        layout: 'oneColumn',
        id: '1',
        emphasis: 'none',
        columns: [
          {
            id: '1',
            width: 12,
            webparts: [{ id: randomUUID(), innerHtml: contentHtml }],
          },
        ],
      },
    ],
  };
}

interface CreateSitePageArgs {
  siteId?: string;
  title?: string;
  name?: string;
  description?: string;
  pageLayout?: 'article' | 'home';
  promotionKind?: 'page' | 'newsPost';
  contentHtml?: string;
}

export async function createSitePage(
  client: Client,
  args: CreateSitePageArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.title) {
    return errorResult(
      'Missing required parameters: "siteId" and "title". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "title": "Q3 Update", ' +
      '"contentHtml": "<p>Summary…</p>" }. ' +
      'The page is created as a draft — call publish_site_page to make it visible.',
    );
  }

  const body: Record<string, unknown> = {
    '@odata.type': '#microsoft.graph.sitePage',
    title: args.title,
    name: args.name ?? derivePageName(args.title),
    pageLayout: args.pageLayout ?? 'article',
    ...(args.description ? { description: args.description } : {}),
    ...(args.promotionKind ? { promotionKind: args.promotionKind } : {}),
    ...(args.contentHtml ? { canvasLayout: buildTextCanvasLayout(args.contentHtml) } : {}),
  };

  const response = await client.api(`/sites/${args.siteId}/pages`).options({ signal }).post(body);
  const page = GraphSitePageSchema.parse(response);

  return successResult({
    success: true,
    id: page.id,
    name: wrapUntrusted(page.name, 'microsoft-sharepoint:create_site_page:name'),
    title: wrapUntrusted(page.title, 'microsoft-sharepoint:create_site_page:title'),
    webUrl: page.webUrl,
    publishingState: page.publishingState?.level,
    message: 'Page created as a draft. Call publish_site_page to make it visible to readers.',
  });
}

interface UpdateSitePageArgs {
  siteId?: string;
  pageId?: string;
  title?: string;
  description?: string;
  promotionKind?: 'page' | 'newsPost';
}

export async function updateSitePage(
  client: Client,
  args: UpdateSitePageArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.pageId) {
    return errorResult(
      'Missing required parameters: "siteId" and "pageId". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "pageId": "abc123", "title": "New title" }',
    );
  }

  const updates: Record<string, unknown> = { '@odata.type': '#microsoft.graph.sitePage' };
  if (args.title !== undefined) updates.title = args.title;
  if (args.description !== undefined) updates.description = args.description;
  if (args.promotionKind !== undefined) updates.promotionKind = args.promotionKind;

  if (Object.keys(updates).length === 1) {
    return errorResult(
      'Nothing to update. Provide at least one of: "title", "description", "promotionKind".',
    );
  }

  const endpoint = `/sites/${args.siteId}/pages/${args.pageId}/microsoft.graph.sitePage`;
  const response = await client.api(endpoint).options({ signal }).patch(updates);
  const page = GraphSitePageSchema.parse(response);

  return successResult({
    success: true,
    id: page.id,
    title: wrapUntrusted(page.title, 'microsoft-sharepoint:update_site_page:title'),
    webUrl: page.webUrl,
    publishingState: page.publishingState?.level,
    message: 'Page updated successfully. If the page was already published, call publish_site_page to publish the new version.',
  });
}

interface PublishSitePageArgs {
  siteId?: string;
  pageId?: string;
}

export async function publishSitePage(
  client: Client,
  args: PublishSitePageArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.pageId) {
    return errorResult(
      'Missing required parameters: "siteId" and "pageId". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "pageId": "abc123" }',
    );
  }

  const endpoint = `/sites/${args.siteId}/pages/${args.pageId}/microsoft.graph.sitePage/publish`;
  await client.api(endpoint).options({ signal }).post({});

  return successResult({
    success: true,
    message:
      'Page published successfully. If a page approval flow is active on the page library, ' +
      'the page becomes visible once the approval completes.',
  });
}

// -- SharePoint Lists tool implementations --

interface ListSiteListsArgs {
  siteId?: string;
  top?: number;
}

export async function listSiteLists(
  client: Client,
  args: ListSiteListsArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId) {
    return errorResult(
      'Missing required parameter: "siteId" (SharePoint site ID). ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456" }. ' +
      'Use list_sharepoint_sites to find sites first.',
    );
  }

  const top = Math.min(args.top ?? 50, 200);

  const response = await client
    .api(`/sites/${args.siteId}/lists`)
    .options({ signal })
    .top(top)
    .select('id,displayName,description,webUrl,createdDateTime,lastModifiedDateTime,list')
    .get();

  const lists = (response.value ?? []).map((list: Record<string, unknown>) => ({
    id: list.id,
    displayName: wrapUntrusted(
      typeof list.displayName === 'string' ? list.displayName : undefined,
      'microsoft-sharepoint:list_site_lists:displayName',
    ),
    description: wrapUntrusted(
      typeof list.description === 'string' ? list.description : undefined,
      'microsoft-sharepoint:list_site_lists:description',
    ),
    webUrl: list.webUrl,
    createdAt: list.createdDateTime,
    modifiedAt: list.lastModifiedDateTime,
    template: (list.list as Record<string, unknown>)?.template,
    hidden: (list.list as Record<string, unknown>)?.hidden,
  }));

  return successResult({
    siteId: args.siteId,
    count: lists.length,
    lists,
  });
}

interface ListListItemsArgs {
  siteId?: string;
  listId?: string;
  top?: number;
  filter?: string;
}

export async function listListItems(
  client: Client,
  args: ListListItemsArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.listId) {
    return errorResult(
      'Missing required parameters: "siteId" and "listId". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "listId": "abc-123-def" }. ' +
      'Use list_site_lists to find lists first.',
    );
  }

  const top = Math.min(args.top ?? 50, 200);

  let request = client
    .api(`/sites/${args.siteId}/lists/${args.listId}/items`)
    .options({ signal })
    .expand('fields')
    .top(top);

  if (args.filter) {
    request = request.filter(args.filter);
  }

  const response = await request.get();

  const items = (response.value ?? []).map((item: Record<string, unknown>) => ({
    id: item.id,
    createdAt: item.createdDateTime,
    modifiedAt: item.lastModifiedDateTime,
    webUrl: item.webUrl,
    fields: wrapUntrustedJsonStrings(item.fields, 'microsoft-sharepoint:list_list_items:fields'),
  }));

  return successResult({
    siteId: args.siteId,
    listId: args.listId,
    count: items.length,
    items,
  });
}

interface GetListItemArgs {
  siteId?: string;
  listId?: string;
  itemId?: string;
}

export async function getListItem(
  client: Client,
  args: GetListItemArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.listId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "siteId", "listId", and "itemId". ' +
      'Example: { "siteId": "...", "listId": "...", "itemId": "1" }',
    );
  }

  const item = await client
    .api(`/sites/${args.siteId}/lists/${args.listId}/items/${args.itemId}`)
    .options({ signal })
    .expand('fields')
    .get();

  return successResult({
    id: item.id,
    createdAt: item.createdDateTime,
    modifiedAt: item.lastModifiedDateTime,
    webUrl: item.webUrl,
    fields: wrapUntrustedJsonStrings(item.fields, 'microsoft-sharepoint:get_list_item:fields'),
  });
}

interface CreateListItemArgs {
  siteId?: string;
  listId?: string;
  fields?: Record<string, unknown>;
}

export async function createListItem(
  client: Client,
  args: CreateListItemArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.listId || !args.fields) {
    return errorResult(
      'Missing required parameters: "siteId", "listId", and "fields" (column values). ' +
      'Example: { "siteId": "...", "listId": "...", "fields": { "Title": "New item", "Status": "Active" } }',
    );
  }

  try {
    const response = await client
      .api(`/sites/${args.siteId}/lists/${args.listId}/items`)
      .options({ signal })
      .post({ fields: args.fields });

    return successResult({
      success: true,
      id: response.id,
      webUrl: response.webUrl,
      fields: wrapUntrustedJsonStrings(
        response.fields,
        'microsoft-sharepoint:create_list_item:fields',
      ),
      message: 'List item created successfully',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('DocumentLibrary') || msg.includes('OneDrive API')) {
      return errorResult(
        'This list is backed by a document library (e.g., Site Pages, Documents). ' +
        'Items cannot be added via the Lists API — use upload_library_file or create_library_folder instead.',
      );
    }
    throw err;
  }
}

interface UpdateListItemArgs {
  siteId?: string;
  listId?: string;
  itemId?: string;
  fields?: Record<string, unknown>;
}

export async function updateListItem(
  client: Client,
  args: UpdateListItemArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.listId || !args.itemId || !args.fields) {
    return errorResult(
      'Missing required parameters: "siteId", "listId", "itemId", and "fields" (column values to update). ' +
      'Example: { "siteId": "...", "listId": "...", "itemId": "1", "fields": { "Status": "Complete" } }',
    );
  }

  await client
    .api(`/sites/${args.siteId}/lists/${args.listId}/items/${args.itemId}/fields`)
    .options({ signal })
    .patch(args.fields);

  return successResult({
    success: true,
    message: 'List item updated successfully',
  });
}

interface DeleteListItemArgs {
  siteId?: string;
  listId?: string;
  itemId?: string;
}

export async function deleteListItem(
  client: Client,
  args: DeleteListItemArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.listId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "siteId", "listId", and "itemId". ' +
      'Example: { "siteId": "...", "listId": "...", "itemId": "1" }',
    );
  }

  await client
    .api(`/sites/${args.siteId}/lists/${args.listId}/items/${args.itemId}`)
    .options({ signal })
    .delete();

  return successResult({
    success: true,
    message: 'List item deleted successfully',
  });
}

// -- List schema tool implementations --

interface ListListColumnsArgs {
  siteId?: string;
  listId?: string;
}

export async function listListColumns(
  client: Client,
  args: ListListColumnsArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.listId) {
    return errorResult(
      'Missing required parameters: "siteId" and "listId". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "listId": "abc-123-def" }. ' +
      'Use list_site_lists to find lists first.',
    );
  }

  const response = await client
    .api(`/sites/${args.siteId}/lists/${args.listId}/columns`)
    .options({ signal })
    .get();
  const columns = parseGraphCollection(GraphColumnDefinitionSchema, response);

  return successResult({
    siteId: args.siteId,
    listId: args.listId,
    count: columns.length,
    columns: columns.map((column) => ({
      id: column.id,
      name: column.name,
      displayName: wrapUntrusted(column.displayName, 'microsoft-sharepoint:list_list_columns:displayName'),
      description: wrapUntrusted(column.description, 'microsoft-sharepoint:list_list_columns:description'),
      type: COLUMN_TYPE_FACETS.find((facet) => column[facet] !== undefined) ?? 'unknown',
      required: column.required ?? false,
      hidden: column.hidden ?? false,
      readOnly: column.readOnly ?? false,
    })),
  });
}

type NewListColumnType = 'text' | 'number' | 'dateTime' | 'boolean' | 'choice';

interface NewListColumn {
  name: string;
  type: NewListColumnType;
  required?: boolean;
  choices?: string[];
}

function buildColumnDefinition(column: NewListColumn): Record<string, unknown> {
  const definition: Record<string, unknown> = { name: column.name };
  if (column.required) definition.required = true;
  switch (column.type) {
    case 'text':
      definition.text = {};
      break;
    case 'number':
      definition.number = {};
      break;
    case 'dateTime':
      definition.dateTime = {};
      break;
    case 'boolean':
      definition.boolean = {};
      break;
    case 'choice':
      definition.choice = { choices: column.choices ?? [] };
      break;
  }
  return definition;
}

interface CreateSiteListArgs {
  siteId?: string;
  displayName?: string;
  description?: string;
  template?: string;
  columns?: NewListColumn[];
}

export async function createSiteList(
  client: Client,
  args: CreateSiteListArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.displayName) {
    return errorResult(
      'Missing required parameters: "siteId" and "displayName". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "displayName": "Project Tracker", ' +
      '"columns": [{ "name": "Status", "type": "choice", "choices": ["Active", "Complete"] }] }',
    );
  }

  for (const column of args.columns ?? []) {
    if (column.type === 'choice' && (!column.choices || column.choices.length === 0)) {
      return errorResult(
        `Column "${column.name}" is of type "choice" but has no "choices" array. ` +
        'Provide at least one choice value.',
      );
    }
  }

  const body: Record<string, unknown> = {
    displayName: args.displayName,
    list: { template: args.template ?? 'genericList' },
    ...(args.description ? { description: args.description } : {}),
    ...(args.columns && args.columns.length > 0
      ? { columns: args.columns.map(buildColumnDefinition) }
      : {}),
  };

  const response = await client.api(`/sites/${args.siteId}/lists`).options({ signal }).post(body);
  const created = GraphListSchema.parse(response);

  return successResult({
    success: true,
    id: created.id,
    displayName: wrapUntrusted(created.displayName, 'microsoft-sharepoint:create_site_list:displayName'),
    webUrl: created.webUrl,
    template: created.list?.template,
    message: 'List created successfully',
  });
}

// -- Cross-site search tool implementation --

interface SearchSharePointArgs {
  query?: string;
  entityTypes?: string[];
  top?: number;
}

export async function searchSharePoint(
  client: Client,
  args: SearchSharePointArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.query) {
    return errorResult(
      'Missing required parameter: "query" (search text). ' +
      'Example: { "query": "quarterly report", "entityTypes": ["driveItem", "listItem"], "top": 25 }',
    );
  }

  const top = Math.min(args.top ?? 25, 100);
  const entityTypes = args.entityTypes ?? ['driveItem', 'listItem', 'list', 'site'];

  const response = await client
    .api('/search/query')
    .options({ signal })
    .post({
      requests: [{
        entityTypes,
        query: { queryString: args.query },
        from: 0,
        size: top,
      }],
    });

  const results: unknown[] = [];
  for (const searchResponse of response.value ?? []) {
    for (const hitContainer of searchResponse.hitsContainers ?? []) {
      for (const hit of hitContainer.hits ?? []) {
        results.push({
          rank: hit.rank,
          summary: wrapUntrusted(hit.summary, 'microsoft-sharepoint:search_sharepoint:summary'),
          resource: {
            id: hit.resource?.id,
            name: wrapUntrusted(
              hit.resource?.name ?? hit.resource?.displayName,
              'microsoft-sharepoint:search_sharepoint:resource.name',
            ),
            webUrl: hit.resource?.webUrl,
            type: hit.resource?.['@odata.type'],
            lastModifiedDateTime: hit.resource?.lastModifiedDateTime,
            createdBy: wrapUntrusted(
              hit.resource?.createdBy?.user?.displayName,
              'microsoft-sharepoint:search_sharepoint:createdBy',
            ),
            lastModifiedBy: wrapUntrusted(
              hit.resource?.lastModifiedBy?.user?.displayName,
              'microsoft-sharepoint:search_sharepoint:lastModifiedBy',
            ),
            parentReference: hit.resource?.parentReference ? {
              siteId: hit.resource.parentReference.siteId,
              driveId: hit.resource.parentReference.driveId,
              path: wrapUntrusted(
                hit.resource.parentReference.path,
                'microsoft-sharepoint:search_sharepoint:path',
              ),
            } : undefined,
          },
        });
      }
    }
  }

  return successResult({
    query: args.query,
    entityTypes,
    count: results.length,
    results,
  });
}

// -- Rename tool implementation --

interface RenameLibraryItemArgs {
  driveId?: string;
  itemId?: string;
  newName?: string;
}

export async function renameLibraryItem(
  client: Client,
  args: RenameLibraryItemArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId || !args.newName) {
    return errorResult(
      'Missing required parameters: "driveId", "itemId", and "newName". ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF...", "newName": "report-final.docx" }',
    );
  }

  const endpoint = buildDriveEndpoint(args.driveId, args.itemId);
  const response = await client.api(endpoint).options({ signal }).patch({ name: args.newName });

  return successResult({
    success: true,
    id: response.id,
    name: wrapUntrusted(response.name, 'microsoft-sharepoint:rename_library_item:name'),
    webUrl: response.webUrl,
    message: 'Item renamed successfully',
  });
}

// -- Sharing link tool implementation --

interface CreateSharingLinkArgs {
  driveId?: string;
  itemId?: string;
  type?: 'view' | 'edit';
  scope?: 'anonymous' | 'organization';
}

export async function createSharingLink(
  client: Client,
  args: CreateSharingLinkArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId || !args.type) {
    return errorResult(
      'Missing required parameters: "driveId", "itemId", and "type" ("view" or "edit"). ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF...", "type": "view" }',
    );
  }

  const endpoint = `${buildDriveEndpoint(args.driveId, args.itemId)}/createLink`;
  const response = await client.api(endpoint).options({ signal }).post({
    type: args.type,
    scope: args.scope ?? 'organization',
  });

  return successResult({
    success: true,
    link: response.link?.webUrl,
    type: response.link?.type,
    scope: response.link?.scope,
    id: response.id,
    roles: response.roles,
  });
}

// -- File version history tool implementation --

interface ListFileVersionsArgs {
  driveId?: string;
  itemId?: string;
  top?: number;
}

export async function listFileVersions(
  client: Client,
  args: ListFileVersionsArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "driveId" (document library ID) and "itemId" (file ID). ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF..." }',
    );
  }

  const top = Math.min(args.top ?? 50, 200);
  const endpoint = `${buildDriveEndpoint(args.driveId, args.itemId)}/versions`;
  const response = await client.api(endpoint).options({ signal }).top(top).get();
  const versions = parseGraphCollection(GraphDriveItemVersionSchema, response);

  return successResult({
    driveId: args.driveId,
    itemId: args.itemId,
    count: versions.length,
    versions: versions.map((version) => ({
      id: version.id,
      size: formatSize(version.size),
      modifiedAt: version.lastModifiedDateTime,
      modifiedBy: wrapUntrusted(
        version.lastModifiedBy?.user?.displayName,
        'microsoft-sharepoint:list_file_versions:modifiedBy',
      ),
    })),
  });
}

// -- Item permission tool implementations --

interface ListItemPermissionsArgs {
  driveId?: string;
  itemId?: string;
}

export async function listItemPermissions(
  client: Client,
  args: ListItemPermissionsArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "driveId" and "itemId". ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF..." }',
    );
  }

  const endpoint = `${buildDriveEndpoint(args.driveId, args.itemId)}/permissions`;
  const response = await client.api(endpoint).options({ signal }).get();
  const permissions = parseGraphCollection(GraphPermissionSchema, response);

  return successResult({
    driveId: args.driveId,
    itemId: args.itemId,
    count: permissions.length,
    permissions: permissions.map((permission) => formatPermission(permission, 'list_item_permissions')),
  });
}

interface InviteItemCollaboratorsArgs {
  driveId?: string;
  itemId?: string;
  recipients?: string[];
  role?: 'read' | 'write';
  message?: string;
  sendInvitation?: boolean;
}

export async function inviteItemCollaborators(
  client: Client,
  args: InviteItemCollaboratorsArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId || !args.recipients || args.recipients.length === 0) {
    return errorResult(
      'Missing required parameters: "driveId", "itemId", and "recipients" (non-empty array of email addresses). ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF...", "recipients": ["jane@example.com"], "role": "read" }',
    );
  }

  const endpoint = `${buildDriveEndpoint(args.driveId, args.itemId)}/invite`;
  const response = await client.api(endpoint).options({ signal }).post({
    recipients: args.recipients.map((email) => ({ email })),
    requireSignIn: true,
    // Default to NOT sending a notification email — a surprise email to an
    // external recipient is a side effect the caller must opt into.
    sendInvitation: args.sendInvitation ?? false,
    roles: [args.role ?? 'read'],
    ...(args.message ? { message: args.message } : {}),
  });

  const granted = parseGraphCollection(GraphPermissionSchema, response);

  return successResult({
    success: true,
    driveId: args.driveId,
    itemId: args.itemId,
    granted: granted.map((permission) => formatPermission(permission, 'invite_item_collaborators')),
    message: `Granted ${args.role ?? 'read'} access to ${args.recipients.length} recipient(s)`,
  });
}

interface RevokeItemPermissionArgs {
  driveId?: string;
  itemId?: string;
  permissionId?: string;
}

export async function revokeItemPermission(
  client: Client,
  args: RevokeItemPermissionArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId || !args.permissionId) {
    return errorResult(
      'Missing required parameters: "driveId", "itemId", and "permissionId". ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF...", "permissionId": "perm-1" }. ' +
      'Use list_item_permissions to find permission IDs.',
    );
  }

  const endpoint = `${buildDriveEndpoint(args.driveId, args.itemId)}/permissions/${args.permissionId}`;
  await client.api(endpoint).options({ signal }).delete();

  return successResult({
    success: true,
    message: 'Permission revoked successfully',
  });
}

// -- Subsites tool implementation --

interface ListSubsitesArgs {
  siteId?: string;
  top?: number;
}

export async function listSubsites(
  client: Client,
  args: ListSubsitesArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId) {
    return errorResult(
      'Missing required parameter: "siteId" (SharePoint site ID). ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456" }',
    );
  }

  const top = Math.min(args.top ?? 50, 200);

  const response = await client
    .api(`/sites/${args.siteId}/sites`)
    .options({ signal })
    .top(top)
    .select('id,displayName,name,webUrl,description,createdDateTime,lastModifiedDateTime')
    .get();

  const sites = (response.value ?? []).map((site: Record<string, unknown>) => ({
    id: site.id,
    displayName: wrapUntrusted(
      typeof site.displayName === 'string' ? site.displayName : undefined,
      'microsoft-sharepoint:list_subsites:displayName',
    ),
    name: wrapUntrusted(
      typeof site.name === 'string' ? site.name : undefined,
      'microsoft-sharepoint:list_subsites:name',
    ),
    webUrl: site.webUrl,
    description: wrapUntrusted(
      typeof site.description === 'string' ? site.description : undefined,
      'microsoft-sharepoint:list_subsites:description',
    ),
    createdAt: site.createdDateTime,
    modifiedAt: site.lastModifiedDateTime,
  }));

  return successResult({
    parentSiteId: args.siteId,
    count: sites.length,
    subsites: sites,
  });
}

// -- Recent files tool implementation --

interface GetRecentFilesArgs {
  top?: number;
}

export async function getRecentFiles(
  client: Client,
  args: GetRecentFilesArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  const top = Math.min(args.top ?? 25, 100);

  const response = await client
    .api('/me/drive/recent')
    .options({ signal })
    .top(top)
    .get();

  const items = (response.value ?? []).map((item: DriveItem) => ({
    id: item.id,
    name: wrapUntrusted(item.name, 'microsoft-sharepoint:get_recent_files:name'),
    type: item.folder ? 'folder' : 'file',
    size: formatSize(item.size),
    mimeType: item.file?.mimeType,
    modifiedAt: item.lastModifiedDateTime,
    webUrl: item.webUrl,
    parentDriveId: (item.parentReference as Record<string, unknown>)?.driveId,
    parentSiteId: (item.parentReference as Record<string, unknown>)?.siteId,
  }));

  return successResult({
    count: items.length,
    items,
    note:
      'Results come from the current user\'s personal OneDrive (/me/drive/recent), ' +
      'not from SharePoint site document libraries.',
  });
}

// -- Additional site/drive/list detail tools --

interface GetSiteDriveArgs {
  siteId?: string;
  driveId?: string;
}

export async function getSiteDrive(
  client: Client,
  args: GetSiteDriveArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.driveId) {
    return errorResult(
      'Missing required parameters: "siteId" and "driveId". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "driveId": "b!xyz..." }',
    );
  }

  const drive = await client
    .api(`/sites/${args.siteId}/drives/${args.driveId}`)
    .options({ signal })
    .select('id,name,driveType,owner,quota,webUrl,createdDateTime,lastModifiedDateTime')
    .get();

  return successResult(formatDrive(drive, 'get_site_drive'));
}

interface ListSiteItemsArgs {
  siteId?: string;
  top?: number;
}

export async function listSiteItems(
  client: Client,
  args: ListSiteItemsArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId) {
    return errorResult(
      'Missing required parameter: "siteId". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456" }',
    );
  }

  const top = Math.min(args.top ?? 50, 200);

  try {
    const response = await client
      .api(`/sites/${args.siteId}/items`)
      .options({ signal })
      .top(top)
      .get();

    const items = (response.value ?? []).map((item: Record<string, unknown>) => ({
      id: item.id,
      name: wrapUntrusted(
        typeof item.name === 'string' ? item.name : undefined,
        'microsoft-sharepoint:list_site_items:name',
      ),
      webUrl: item.webUrl,
      contentType: wrapUntrusted(
        typeof (item.contentType as Record<string, unknown>)?.name === 'string'
          ? ((item.contentType as Record<string, string>).name)
          : undefined,
        'microsoft-sharepoint:list_site_items:contentType.name',
      ),
      createdAt: item.createdDateTime,
      modifiedAt: item.lastModifiedDateTime,
    }));

    return successResult({
      siteId: args.siteId,
      count: items.length,
      items,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('malformed') || msg.includes('incorrect')) {
      return errorResult(
        'The /sites/{id}/items endpoint is not available for this site. ' +
        'Use list_site_lists to discover lists, then list_list_items to browse items within a specific list.',
      );
    }
    throw err;
  }
}

interface GetSiteItemArgs {
  siteId?: string;
  itemId?: string;
}

export async function getSiteItem(
  client: Client,
  args: GetSiteItemArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "siteId" and "itemId". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "itemId": "1" }',
    );
  }

  try {
    const item = await client
      .api(`/sites/${args.siteId}/items/${args.itemId}`)
      .options({ signal })
      .get();

    return successResult({
      id: item.id,
      name: wrapUntrusted(item.name, 'microsoft-sharepoint:get_site_item:name'),
      webUrl: item.webUrl,
      contentType: wrapUntrusted(
        item.contentType?.name,
        'microsoft-sharepoint:get_site_item:contentType.name',
      ),
      createdAt: item.createdDateTime,
      modifiedAt: item.lastModifiedDateTime,
      fields: wrapUntrustedJsonStrings(item.fields, 'microsoft-sharepoint:get_site_item:fields'),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not valid') || msg.includes('malformed')) {
      return errorResult(
        'Invalid site item ID. Site items use numeric IDs (e.g., "1", "2"), not drive item IDs. ' +
        'Use list_site_items or list_list_items to discover valid item IDs.',
      );
    }
    throw err;
  }
}

interface GetSiteListArgs {
  siteId?: string;
  listId?: string;
}

export async function getSiteList(
  client: Client,
  args: GetSiteListArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.listId) {
    return errorResult(
      'Missing required parameters: "siteId" and "listId". ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "listId": "..." }',
    );
  }

  const list = await client
    .api(`/sites/${args.siteId}/lists/${args.listId}`)
    .options({ signal })
    .select('id,displayName,name,description,webUrl,createdDateTime,lastModifiedDateTime,list')
    .get();

  return successResult({
    id: list.id,
    displayName: wrapUntrusted(list.displayName, 'microsoft-sharepoint:get_site_list:displayName'),
    name: wrapUntrusted(list.name, 'microsoft-sharepoint:get_site_list:name'),
    description: wrapUntrusted(list.description, 'microsoft-sharepoint:get_site_list:description'),
    webUrl: list.webUrl,
    template: list.list?.template,
    hidden: list.list?.hidden,
    contentTypesEnabled: list.list?.contentTypesEnabled,
    createdAt: list.createdDateTime,
    modifiedAt: list.lastModifiedDateTime,
  });
}

interface GetSiteByPathArgs {
  siteId?: string;
  path?: string;
}

export async function getSiteByPath(
  client: Client,
  args: GetSiteByPathArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.siteId || !args.path) {
    return errorResult(
      'Missing required parameters: "siteId" (parent site) and "path" (relative path to subsite). ' +
      'Example: { "siteId": "contoso.sharepoint.com,abc123,def456", "path": "/departments/hr" }',
    );
  }

  const p = args.path.startsWith('/') ? args.path : `/${args.path}`;
  const site = await client
    .api(`/sites/${args.siteId}/getByPath(path='${p}')`)
    .options({ signal })
    .select('id,displayName,name,webUrl,description,createdDateTime,lastModifiedDateTime,root,siteCollection')
    .get();

  return successResult(formatSite(site, 'get_site_by_path'));
}

interface GetSitesDeltaArgs {
  deltaLink?: string;
}

export async function getSitesDelta(
  client: Client,
  args: GetSitesDeltaArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  const endpoint = args.deltaLink || '/sites/delta()';

  try {
    const response = await client.api(endpoint).options({ signal }).get();

    const sites = (response.value ?? []).map((site: Record<string, unknown>) => ({
      id: site.id,
      displayName: wrapUntrusted(
        typeof site.displayName === 'string' ? site.displayName : undefined,
        'microsoft-sharepoint:get_sites_delta:displayName',
      ),
      name: wrapUntrusted(
        typeof site.name === 'string' ? site.name : undefined,
        'microsoft-sharepoint:get_sites_delta:name',
      ),
      webUrl: site.webUrl,
      isDeleted: !!(site as Record<string, unknown>)['@removed'],
    }));

    return successResult({
      count: sites.length,
      sites,
      deltaLink: response['@odata.deltaLink'],
      nextLink: response['@odata.nextLink'],
      note: 'Use deltaLink in the next call to get only changes since this response.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Access denied') || msg.includes('403')) {
      return errorResult(
        'Access denied for sites delta. This endpoint may require admin consent for Sites.Read.All. ' +
        'Use list_sharepoint_sites with a search query as an alternative.',
      );
    }
    throw err;
  }
}

// -- Library tree tool implementation --

interface TreeNode {
  name: string;
  type: 'file' | 'folder';
  size?: string;
  childCount?: number;
  children?: TreeNode[];
}

interface GetLibraryTreeArgs {
  driveId?: string;
  folderId?: string;
  maxDepth?: number;
  maxItemsPerLevel?: number;
}

async function buildTree(
  client: Client,
  driveId: string,
  folderId: string | undefined,
  depth: number,
  maxDepth: number,
  maxItems: number,
  signal: AbortSignal,
): Promise<TreeNode[]> {
  const endpoint = folderId
    ? `/drives/${driveId}/items/${folderId}/children`
    : `/drives/${driveId}/root/children`;

  const response = await client
    .api(endpoint)
    .options({ signal })
    .top(maxItems)
    .select('id,name,folder,file,size')
    .get();

  const nodes: TreeNode[] = [];
  for (const item of response.value ?? []) {
    const isFolder = !!item.folder;
    const node: TreeNode = {
      name: wrapUntrusted(item.name, 'microsoft-sharepoint:get_library_tree:name') ?? '',
      type: isFolder ? 'folder' : 'file',
      ...(isFolder ? { childCount: item.folder.childCount } : { size: formatSize(item.size) }),
    };

    if (isFolder && depth < maxDepth) {
      node.children = await buildTree(client, driveId, item.id, depth + 1, maxDepth, maxItems, signal);
    }

    nodes.push(node);
  }
  return nodes;
}

export async function getLibraryTree(
  client: Client,
  args: GetLibraryTreeArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId) {
    return errorResult(
      'Missing required parameter: "driveId" (document library drive ID). ' +
      'Example: { "driveId": "b!abc123..." }',
    );
  }

  const maxDepth = Math.min(args.maxDepth ?? 10, 15);
  const maxItems = Math.min(args.maxItemsPerLevel ?? 100, 200);

  const tree = await buildTree(client, args.driveId, args.folderId, 0, maxDepth, maxItems, signal);

  return successResult({
    driveId: args.driveId,
    folderId: args.folderId ?? 'root',
    maxDepth,
    maxItemsPerLevel: maxItems,
    tree,
  });
}

// -- File metadata tool implementations --

interface GetFileMetadataArgs {
  driveId?: string;
  itemId?: string;
}

export async function getFileMetadata(
  client: Client,
  args: GetFileMetadataArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId) {
    return errorResult(
      'Missing required parameters: "driveId" and "itemId". ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF..." }',
    );
  }

  const endpoint = `${buildDriveEndpoint(args.driveId, args.itemId)}/listItem/fields`;
  const response = await client.api(endpoint).options({ signal }).get();

  // Remove OData metadata fields for cleaner output
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(response)) {
    if (!key.startsWith('@odata') && !key.startsWith('odata') && value != null) {
      fields[key] = value;
    }
  }

  return successResult({
    driveId: args.driveId,
    itemId: args.itemId,
    fields: wrapUntrustedJsonStrings(fields, 'microsoft-sharepoint:get_file_metadata:fields'),
  });
}

interface UpdateFileMetadataArgs {
  driveId?: string;
  itemId?: string;
  fields?: Record<string, unknown>;
}

export async function updateFileMetadata(
  client: Client,
  args: UpdateFileMetadataArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!args.driveId || !args.itemId || !args.fields) {
    return errorResult(
      'Missing required parameters: "driveId", "itemId", and "fields". ' +
      'Example: { "driveId": "b!abc123...", "itemId": "01ABCDEF...", "fields": { "Department": "Marketing" } }',
    );
  }

  if (Object.keys(args.fields).length === 0) {
    return errorResult('The "fields" object must contain at least one field to update.');
  }

  const endpoint = `${buildDriveEndpoint(args.driveId, args.itemId)}/listItem/fields`;
  const response = await client.api(endpoint).options({ signal }).patch(args.fields);

  const updatedFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(response)) {
    if (!key.startsWith('@odata') && !key.startsWith('odata') && value != null) {
      updatedFields[key] = value;
    }
  }

  return successResult({
    success: true,
    driveId: args.driveId,
    itemId: args.itemId,
    updatedFields: wrapUntrustedJsonStrings(
      updatedFields,
      'microsoft-sharepoint:update_file_metadata:updatedFields',
    ),
    message: `Updated ${Object.keys(args.fields).length} field(s)`,
  });
}
