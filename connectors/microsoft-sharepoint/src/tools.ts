import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasScope, type Client, type ToolResult, SHAREPOINT_REQUIRED_SCOPE } from '@mindstone/mcp-server-microsoft-shared';
import { z } from 'zod';
import { callGraph, getTokenProvider } from './client.js';
import { authRequiredJson, errorResponse, withErrorHandling } from './utils.js';
import { AUTH_TOOL_NAME } from './types.js';
import {
  copyLibraryItem,
  createLibraryFolder,
  createListItem,
  createSharingLink,
  createSiteList,
  deleteLibraryItem,
  deleteListItem,
  downloadLibraryFile,
  getFileMetadata,
  getLibraryFile,
  getLibraryTree,
  getListItem,
  getRecentFiles,
  getSharePointSite,
  getSiteByPath,
  getSiteDrive,
  getSiteItem,
  getSiteList,
  getSitesDelta,
  inviteItemCollaborators,
  listFileVersions,
  listItemPermissions,
  listLibraryFiles,
  listListColumns,
  listListItems,
  listSharePointSites,
  listSiteDocumentLibraries,
  listSiteItems,
  listSiteLists,
  listSitePages,
  listSubsites,
  moveLibraryItem,
  readLibraryTextFile,
  readSitePage,
  renameLibraryItem,
  revokeItemPermission,
  searchLibraryFiles,
  searchSharePoint,
  updateFileMetadata,
  updateListItem,
  uploadLibraryFile,
} from './sharepoint.js';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

const IDP_WRITE_ANNOTATIONS = {
  ...WRITE_ANNOTATIONS,
  idempotentHint: true,
} as const;

type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
};

type SharePointHandler = (
  client: Client,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<ToolResult>;

type SharePointToolSpec = {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotations;
  handler: SharePointHandler;
};

const SearchEntityTypeEnum = z.enum(['driveItem', 'listItem', 'list', 'site']);
const SharingTypeEnum = z.enum(['view', 'edit']);
const SharingScopeEnum = z.enum(['anonymous', 'organization']);
const ListTemplateEnum = z.enum([
  'genericList',
  'tasks',
  'announcements',
  'contacts',
  'events',
  'links',
  'issueTracking',
]);
const ListColumnTypeEnum = z.enum(['text', 'number', 'dateTime', 'boolean', 'choice']);

async function requireSharePointScope(): Promise<CallToolResult | null> {
  try {
    const tokenData = await getTokenProvider().loadToken();
    if (!tokenData) {
      return errorResponse({
        error: 'No Microsoft account connected.',
        action_required:
          'Call authenticate_sharepoint to connect your Microsoft account and grant SharePoint permissions.',
        next_step: AUTH_TOOL_NAME,
      });
    }
    if (!hasScope(tokenData.scope, SHAREPOINT_REQUIRED_SCOPE)) {
      return errorResponse({
        error:
          'SharePoint permissions not granted. Your Microsoft account is connected but SharePoint access requires additional permissions.',
        action_required:
          'Call authenticate_sharepoint to grant SharePoint permissions. Note: In most organizations, an administrator must approve SharePoint access.',
        next_step: AUTH_TOOL_NAME,
      });
    }
    return null;
  } catch (err) {
    return errorResponse({
      error: `Failed to check SharePoint permissions: ${err instanceof Error ? err.message : String(err)}`,
      action_required: 'Call authenticate_sharepoint to connect your Microsoft account.',
      next_step: AUTH_TOOL_NAME,
    });
  }
}

function ensureRecoveryGuidance(result: ToolResult, toolName: string): CallToolResult {
  if (!result.isError) return result as CallToolResult;
  const first = result.content[0];
  if (!first || first.type !== 'text') return result as CallToolResult;

  try {
    const parsed = JSON.parse(first.text) as Record<string, unknown>;
    if (parsed.ok !== false) return result as CallToolResult;

    const patched: Record<string, unknown> = { ...parsed };
    if (!('action_required' in patched)) {
      patched.action_required = 'Adjust the arguments based on the error and retry.';
    }
    if (!('next_step' in patched)) {
      patched.next_step = toolName;
    }

    return {
      ...result,
      content: [{ type: 'text', text: JSON.stringify(patched) }],
    };
  } catch {
    return result as CallToolResult;
  }
}

function registerScopedTool(server: McpServer, spec: SharePointToolSpec): void {
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: spec.inputSchema.shape,
      annotations: spec.annotations,
    },
    withErrorHandling(async (args, extra): Promise<CallToolResult> => {
      const scopeError = await requireSharePointScope();
      if (scopeError) return scopeError;
      const result = await callGraph(extra, (client, signal) =>
        spec.handler(client, args as Record<string, unknown>, signal),
      );
      return ensureRecoveryGuidance(result, spec.name);
    }),
  );
}

const TOOL_SPECS: SharePointToolSpec[] = [
  {
    name: 'list_sharepoint_sites',
    description:
      'Search for and list SharePoint sites accessible to the user. Returns site name, URL, and description.',
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe('Search query to filter sites (e.g., "Marketing"). If omitted, lists all accessible sites.'),
      top: z.number().optional().describe('Max sites to return (default: 25)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listSharePointSites as SharePointHandler,
  },
  {
    name: 'get_sharepoint_site',
    description: 'Get details about a specific SharePoint site by ID or hostname path.',
    inputSchema: z.object({
      siteId: z
        .string()
        .optional()
        .describe(
          'SharePoint site ID (e.g., "contoso.sharepoint.com,abc123,def456") or hostname path (e.g., "contoso.sharepoint.com:/sites/Marketing")',
        ),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getSharePointSite as SharePointHandler,
  },
  {
    name: 'list_site_document_libraries',
    description: 'List document libraries (drives) in a SharePoint site.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      top: z.number().optional().describe('Max libraries to return (default: 50)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listSiteDocumentLibraries as SharePointHandler,
  },
  {
    name: 'list_library_files',
    description: 'List files and folders in a SharePoint document library. Defaults to root folder.',
    inputSchema: z.object({
      driveId: z
        .string()
        .optional()
        .describe('Document library (drive) ID from list_site_document_libraries'),
      path: z
        .string()
        .optional()
        .describe('Folder path within the library (e.g., "General/Reports"). Omit for root.'),
      top: z.number().optional().describe('Max items to return (default: 50)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listLibraryFiles as SharePointHandler,
  },
  {
    name: 'get_library_file',
    description: 'Get metadata for a specific file or folder in a SharePoint document library.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getLibraryFile as SharePointHandler,
  },
  {
    name: 'download_library_file',
    description: 'Get a download URL for a file in a SharePoint document library (valid for a short period).',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File item ID'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: downloadLibraryFile as SharePointHandler,
  },
  {
    name: 'search_library_files',
    description: 'Search for files in a SharePoint document library by name or content.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      query: z.string().optional().describe('Search query'),
      top: z.number().optional().describe('Max results (default: 25)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: searchLibraryFiles as SharePointHandler,
  },
  {
    name: 'read_library_text_file',
    description:
      'Read the contents of a text file in a SharePoint document library. Only works with text files (txt, md, json, csv, etc.).',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File item ID'),
      maxSize: z.number().optional().describe('Max bytes to read (default: 100KB)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: readLibraryTextFile as SharePointHandler,
  },
  {
    name: 'upload_library_file',
    description: 'Upload a text file to a SharePoint document library (max 4MB).',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      path: z
        .string()
        .optional()
        .describe('Destination path including filename (e.g., "General/notes.txt")'),
      content: z.string().optional().describe('File content (text)'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: uploadLibraryFile as SharePointHandler,
  },
  {
    name: 'create_library_folder',
    description: 'Create a new folder in a SharePoint document library.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      path: z.string().optional().describe('Full path for new folder (e.g., "General/NewFolder")'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: createLibraryFolder as SharePointHandler,
  },
  {
    name: 'delete_library_item',
    description: 'Delete a file or folder from a SharePoint document library.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: deleteLibraryItem as SharePointHandler,
  },
  {
    name: 'move_library_item',
    description: 'Move a file or folder to a new location in a SharePoint document library.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Source document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID to move'),
      destinationFolderId: z.string().optional().describe('Destination folder item ID'),
      destinationDriveId: z
        .string()
        .optional()
        .describe('Destination drive ID (if moving between libraries)'),
      newName: z.string().optional().describe('Optional new name for the item'),
    }),
    annotations: IDP_WRITE_ANNOTATIONS,
    handler: moveLibraryItem as SharePointHandler,
  },
  {
    name: 'copy_library_item',
    description: 'Copy a file or folder to a new location in a SharePoint document library.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Source document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID to copy'),
      destinationFolderId: z.string().optional().describe('Destination folder item ID'),
      destinationDriveId: z
        .string()
        .optional()
        .describe('Destination drive ID (if copying between libraries)'),
      newName: z.string().optional().describe('Optional new name for the copy'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: copyLibraryItem as SharePointHandler,
  },
  {
    name: 'list_site_pages',
    description:
      'List pages in a SharePoint site (Home, About, wiki pages, etc.). Returns page title, URL, and modification info.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      top: z.number().optional().describe('Max pages to return (default: 25)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listSitePages as SharePointHandler,
  },
  {
    name: 'read_site_page',
    description:
      'Read the content of a SharePoint site page. Returns the page HTML content from web parts.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      pageId: z.string().optional().describe('Page ID from list_site_pages'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: readSitePage as SharePointHandler,
  },
  {
    name: 'list_site_lists',
    description:
      'List SharePoint lists in a site (task lists, custom lists, tracking sheets, etc.). Does not include document libraries — use list_site_document_libraries for those.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      top: z.number().optional().describe('Max lists to return (default: 50)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listSiteLists as SharePointHandler,
  },
  {
    name: 'list_list_items',
    description: 'List items in a SharePoint list with all field values. Supports OData filtering.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      listId: z.string().optional().describe('List ID from list_site_lists'),
      top: z.number().optional().describe('Max items to return (default: 50)'),
      filter: z
        .string()
        .optional()
        .describe(`OData filter expression (e.g., "fields/Status eq 'Active'")`),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listListItems as SharePointHandler,
  },
  {
    name: 'get_list_item',
    description: 'Get a specific item from a SharePoint list with all field values.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      listId: z.string().optional().describe('List ID'),
      itemId: z.string().optional().describe('Item ID'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getListItem as SharePointHandler,
  },
  {
    name: 'create_list_item',
    description: 'Create a new item in a SharePoint list.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      listId: z.string().optional().describe('List ID'),
      fields: z
        .record(z.unknown())
        .optional()
        .describe('Column values for the new item (e.g., { "Title": "New task", "Status": "Active" })'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: createListItem as SharePointHandler,
  },
  {
    name: 'update_list_item',
    description: 'Update an existing item in a SharePoint list.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      listId: z.string().optional().describe('List ID'),
      itemId: z.string().optional().describe('Item ID'),
      fields: z
        .record(z.unknown())
        .optional()
        .describe('Column values to update (e.g., { "Status": "Complete" })'),
    }),
    annotations: IDP_WRITE_ANNOTATIONS,
    handler: updateListItem as SharePointHandler,
  },
  {
    name: 'delete_list_item',
    description: 'Delete an item from a SharePoint list.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      listId: z.string().optional().describe('List ID'),
      itemId: z.string().optional().describe('Item ID'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: deleteListItem as SharePointHandler,
  },
  {
    name: 'list_list_columns',
    description:
      'List the column schema of a SharePoint list (column names, types, and required flags). Use this to discover which fields exist before creating or updating list items.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      listId: z.string().optional().describe('List ID from list_site_lists'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listListColumns as SharePointHandler,
  },
  {
    name: 'create_site_list',
    description:
      'Create a new SharePoint list in a site, optionally with a column schema. ' +
      'Requires a write permission (e.g. Sites.ReadWrite.All) — an admin may need to approve it.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      displayName: z.string().optional().describe('Display name for the new list (e.g., "Project Tracker")'),
      description: z.string().optional().describe('Optional description for the list'),
      template: ListTemplateEnum.optional().describe('List template (default: "genericList")'),
      columns: z
        .array(
          z.object({
            name: z.string().describe('Column name (e.g., "Status")'),
            type: ListColumnTypeEnum.describe('Column type'),
            required: z.boolean().optional().describe('Whether the column is required'),
            choices: z
              .array(z.string())
              .optional()
              .describe('Allowed values — required when type is "choice"'),
          }),
        )
        .optional()
        .describe('Optional column definitions for the new list'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: createSiteList as SharePointHandler,
  },
  {
    name: 'search_sharepoint',
    description:
      'Search across all SharePoint sites, document libraries, lists, and list items. More powerful than search_library_files which only searches within a single library.',
    inputSchema: z.object({
      query: z.string().optional().describe('Search query text'),
      entityTypes: z
        .array(SearchEntityTypeEnum)
        .optional()
        .describe('Types of content to search (default: all types)'),
      top: z.number().optional().describe('Max results (default: 25)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: searchSharePoint as SharePointHandler,
  },
  {
    name: 'rename_library_item',
    description: 'Rename a file or folder in a SharePoint document library.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID'),
      newName: z.string().optional().describe('New name for the item (include file extension)'),
    }),
    annotations: IDP_WRITE_ANNOTATIONS,
    handler: renameLibraryItem as SharePointHandler,
  },
  {
    name: 'create_sharing_link',
    description:
      'Create a sharing link for a file or folder in a SharePoint document library. Returns a URL that can be shared with others.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID'),
      type: SharingTypeEnum.optional().describe('Link type: "view" for read-only, "edit" for read-write'),
      scope: SharingScopeEnum.optional().describe('Who can use the link (default: "organization")'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: createSharingLink as SharePointHandler,
  },
  {
    name: 'list_file_versions',
    description:
      'List the version history of a file in a SharePoint document library (version ID, size, modified date, and who modified it).',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File item ID'),
      top: z.number().optional().describe('Max versions to return (default: 50)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listFileVersions as SharePointHandler,
  },
  {
    name: 'list_item_permissions',
    description:
      'List sharing permissions on a file or folder in a SharePoint document library (links and direct grants).',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listItemPermissions as SharePointHandler,
  },
  {
    name: 'invite_item_collaborators',
    description:
      'Grant specific people access to a file or folder in a SharePoint document library by email address. ' +
      'Defaults to read-only access and does NOT send a notification email unless sendInvitation is true. ' +
      'Requires a write permission (e.g. Sites.ReadWrite.All) — an admin may need to approve it.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID'),
      recipients: z
        .array(z.string().email())
        .optional()
        .describe('Email addresses to grant access to (e.g., ["jane@example.com"])'),
      role: z.enum(['read', 'write']).optional().describe('Access level to grant (default: "read")'),
      message: z
        .string()
        .optional()
        .describe('Optional message included in the notification email (only sent when sendInvitation is true)'),
      sendInvitation: z
        .boolean()
        .optional()
        .describe('Send a sharing notification email to recipients (default: false)'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: inviteItemCollaborators as SharePointHandler,
  },
  {
    name: 'revoke_item_permission',
    description:
      'Revoke a sharing permission from a file or folder in a SharePoint document library. Use list_item_permissions to find permission IDs.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID'),
      permissionId: z.string().optional().describe('Permission ID from list_item_permissions'),
    }),
    annotations: WRITE_ANNOTATIONS,
    handler: revokeItemPermission as SharePointHandler,
  },
  {
    name: 'list_subsites',
    description:
      'List subsites of a SharePoint site. Use this to discover nested sites within a site collection.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('Parent SharePoint site ID'),
      top: z.number().optional().describe('Max subsites to return (default: 50)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listSubsites as SharePointHandler,
  },
  {
    name: 'get_recent_files',
    description:
      "Get recently accessed files from the current user's personal OneDrive (via /me/drive/recent). " +
      'Note: this does NOT list recent files from SharePoint site document libraries — ' +
      'use search_library_files or get_library_tree to explore SharePoint content.',
    inputSchema: z.object({
      top: z.number().optional().describe('Max files to return (default: 25)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getRecentFiles as SharePointHandler,
  },
  {
    name: 'get_library_tree',
    description:
      'Get a recursive tree view of a SharePoint document library. Shows the full folder/file hierarchy at a glance. Useful for understanding library structure before navigating into specific folders.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      folderId: z.string().optional().describe('Start from this folder ID instead of root'),
      maxDepth: z.number().optional().describe('Max folder depth to recurse (default: 10, max: 15)'),
      maxItemsPerLevel: z.number().optional().describe('Max items per folder level (default: 100, max: 200)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getLibraryTree as SharePointHandler,
  },
  {
    name: 'get_file_metadata',
    description:
      'Get custom metadata (SharePoint column values) for a file or folder. Returns all custom fields added by site administrators, such as Department, Status, Category, etc.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getFileMetadata as SharePointHandler,
  },
  {
    name: 'update_file_metadata',
    description:
      'Update custom metadata (SharePoint column values) for a file or folder. Set values for custom fields like Department, Status, Category, etc.',
    inputSchema: z.object({
      driveId: z.string().optional().describe('Document library (drive) ID'),
      itemId: z.string().optional().describe('File or folder item ID'),
      fields: z
        .record(z.unknown())
        .optional()
        .describe('Column values to update (e.g., { "Department": "Marketing", "Status": "Approved" })'),
    }),
    annotations: IDP_WRITE_ANNOTATIONS,
    handler: updateFileMetadata as SharePointHandler,
  },
  {
    name: 'get_site_drive',
    description:
      'Get detailed metadata for a specific document library (drive) in a SharePoint site, including quota and owner info.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      driveId: z.string().optional().describe('Document library (drive) ID'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getSiteDrive as SharePointHandler,
  },
  {
    name: 'list_site_items',
    description:
      'List base items across all lists and libraries in a SharePoint site. Returns a cross-list view of content.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      top: z.number().optional().describe('Max items to return (default: 50)'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listSiteItems as SharePointHandler,
  },
  {
    name: 'get_site_item',
    description:
      'Get a specific base item from a SharePoint site by ID, including its field values.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      itemId: z.string().optional().describe('Item ID'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getSiteItem as SharePointHandler,
  },
  {
    name: 'get_site_list',
    description:
      'Get detailed metadata for a specific SharePoint list, including template type, visibility, and content type settings.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('SharePoint site ID'),
      listId: z.string().optional().describe('List ID'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getSiteList as SharePointHandler,
  },
  {
    name: 'get_site_by_path',
    description:
      'Resolve a SharePoint subsite by its relative path from a parent site. Useful for finding sites by URL structure.',
    inputSchema: z.object({
      siteId: z.string().optional().describe('Parent SharePoint site ID'),
      path: z.string().optional().describe('Relative path to subsite (e.g., "/departments/hr")'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getSiteByPath as SharePointHandler,
  },
  {
    name: 'get_sites_delta',
    description:
      'Track changes across SharePoint sites. Returns sites that have been added, modified, or deleted since the last delta query. Pass the deltaLink from a previous response to get incremental changes.',
    inputSchema: z.object({
      deltaLink: z.string().optional().describe('Delta link from a previous response. Omit for initial sync.'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getSitesDelta as SharePointHandler,
  },
];

export function registerSharePointTools(server: McpServer): void {
  server.registerTool(
    AUTH_TOOL_NAME,
    {
      description: `Grant SharePoint permissions for your Microsoft 365 account.

Call this tool when:
1. Other SharePoint tools return "SharePoint permissions not granted" errors
2. The user asks to connect or enable SharePoint access

This tool returns a structured auth_required response. The host will
recognise it and dispatch the incremental SharePoint consent flow.`,
      inputSchema: z.object({}).strict().shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    withErrorHandling(async () => authRequiredJson()),
  );

  for (const spec of TOOL_SPECS) {
    registerScopedTool(server, spec);
  }
}
