import {
  successResult,
  errorResult,
  type ToolResult,
  type DriveItem,
  type SharePointSite,
  type SharePointDrive,
  type Client,
} from '@mindstone/mcp-server-microsoft-shared';

// -- Helpers --

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

function formatSite(site: SharePointSite) {
  return {
    id: site.id,
    displayName: site.displayName,
    name: site.name,
    webUrl: site.webUrl,
    description: site.description,
    createdAt: site.createdDateTime,
    modifiedAt: site.lastModifiedDateTime,
    hostname: site.siteCollection?.hostname,
    isRoot: !!site.root,
  };
}

function formatDrive(drive: SharePointDrive) {
  return {
    id: drive.id,
    name: drive.name,
    description: drive.description,
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
    sites: sites.map(formatSite),
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

  return successResult(formatSite(site));
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
    documentLibraries: drives.map(formatDrive),
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
    items: items.map(formatItem),
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

  return successResult(formatItem(item));
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
    name: item.name,
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
    items: items.map(formatItem),
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
    name: metadata.name,
    size: formatSize(metadata.size),
    mimeType,
    content,
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
    name: response.name,
    size: formatSize(response.size),
    webUrl: response.webUrl,
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
    name: response.name,
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
    name: response.name,
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
    title: page.title,
    name: page.name,
    webUrl: page.webUrl,
    description: page.description,
    createdAt: page.createdDateTime,
    modifiedAt: page.lastModifiedDateTime,
    createdBy: (page.createdBy as Record<string, unknown>)?.user
      ? ((page.createdBy as Record<string, Record<string, string>>).user.displayName)
      : undefined,
    lastModifiedBy: (page.lastModifiedBy as Record<string, unknown>)?.user
      ? ((page.lastModifiedBy as Record<string, Record<string, string>>).user.displayName)
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
  } catch {
    // Page type may not support webparts (e.g., news link pages)
  }

  return successResult({
    id: page.id,
    title: page.title,
    name: page.name,
    webUrl: page.webUrl,
    description: page.description,
    pageLayout: page.pageLayout,
    createdAt: page.createdDateTime,
    modifiedAt: page.lastModifiedDateTime,
    contentHtml: contentParts.length > 0 ? contentParts.join('\n\n') : '(no text content found — page may be empty or use non-text web parts)',
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
    displayName: list.displayName,
    description: list.description,
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
    fields: item.fields,
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
    fields: item.fields,
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
      fields: response.fields,
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
          summary: hit.summary,
          resource: {
            id: hit.resource?.id,
            name: hit.resource?.name ?? hit.resource?.displayName,
            webUrl: hit.resource?.webUrl,
            type: hit.resource?.['@odata.type'],
            lastModifiedDateTime: hit.resource?.lastModifiedDateTime,
            createdBy: hit.resource?.createdBy?.user?.displayName,
            lastModifiedBy: hit.resource?.lastModifiedBy?.user?.displayName,
            parentReference: hit.resource?.parentReference ? {
              siteId: hit.resource.parentReference.siteId,
              driveId: hit.resource.parentReference.driveId,
              path: hit.resource.parentReference.path,
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
    name: response.name,
    webUrl: response.webUrl,
    message: `Item renamed to "${response.name}"`,
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
    displayName: site.displayName,
    name: site.name,
    webUrl: site.webUrl,
    description: site.description,
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
    name: item.name,
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

  return successResult(formatDrive(drive));
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
      name: item.name,
      webUrl: item.webUrl,
      contentType: (item.contentType as Record<string, unknown>)?.name,
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
      name: item.name,
      webUrl: item.webUrl,
      contentType: item.contentType?.name,
      createdAt: item.createdDateTime,
      modifiedAt: item.lastModifiedDateTime,
      fields: item.fields,
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
    displayName: list.displayName,
    name: list.name,
    description: list.description,
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

  return successResult(formatSite(site));
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
      displayName: site.displayName,
      name: site.name,
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
      name: item.name,
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
    fields,
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
    updatedFields,
    message: `Updated ${Object.keys(args.fields).length} field(s)`,
  });
}
