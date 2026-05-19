import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getAccountManager } from '../modules/accounts/index.js';
import { getDriveService } from '../modules/drive/index.js';
import { resolveEmail } from '../utils/account.js';
import { FileListOptions, FileSearchOptions, FileUploadOptions, PermissionOptions } from '../modules/drive/types.js';
import { McpToolResponse } from './types.js';
import {
  readAliasedBoolean,
  readAliasedString
} from './arg-aliases.js';

const HOST_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Get human-readable label for MIME type
 */
function getMimeTypeLabel(mimeType: string): string {
  const labels: Record<string, string> = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.folder': 'Folder',
    'application/vnd.google-apps.form': 'Google Form',
    'application/vnd.google-apps.drawing': 'Google Drawing',
    'application/pdf': 'PDF',
    'application/zip': 'ZIP',
    'text/plain': 'Text',
    'text/csv': 'CSV',
    'text/html': 'HTML',
    'image/jpeg': 'JPEG',
    'image/png': 'PNG',
    'image/gif': 'GIF',
    'video/mp4': 'MP4',
    'audio/mpeg': 'MP3'
  };
  return labels[mimeType] || mimeType.split('/').pop() || 'File';
}

/**
 * Format file size in human-readable form
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format files list as human-readable text
 */
function formatFilesAsText(files: any[]): string {
  if (!files || files.length === 0) {
    return 'No files found.';
  }

  const lines: string[] = [];
  lines.push(`Files: ${files.length} result${files.length !== 1 ? 's' : ''}\n`);

  for (const file of files) {
    const type = getMimeTypeLabel(file.mimeType || 'application/octet-stream');
    const modified = file.modifiedTime 
      ? new Date(file.modifiedTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: HOST_TIMEZONE })
      : '';
    const size = file.size ? formatFileSize(parseInt(file.size)) : '';
    const link = file.webViewLink ? ` [${file.webViewLink}]` : '';
    
    lines.push(`${file.name} (${type})${size ? ` - ${size}` : ''}${modified ? ` - ${modified}` : ''}${link}`);
    lines.push(`  [id: ${file.id}]`);
  }

  return lines.join('\n');
}

interface DriveFileListArgs {
  email?: string;
  options?: FileListOptions;
  return_json?: boolean;
  returnJson?: boolean;
}

interface DriveSearchArgs {
  email?: string;
  options: FileSearchOptions;
  return_json?: boolean;
  returnJson?: boolean;
}

interface DriveUploadArgs {
  email?: string;
  options: FileUploadOptions;
}

interface DriveDownloadArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
  mime_type?: string;
  mimeType?: string;
}

interface DriveFolderArgs {
  email?: string;
  name: string;
  parent_id?: string;
  parentId?: string;
}

interface DrivePermissionArgs {
  email?: string;
  options: PermissionOptions;
}

interface DriveDeleteArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
}

export async function handleListDriveFiles(args: DriveFileListArgs & Record<string, unknown>): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const returnJson = readAliasedBoolean(args, 'return_json', 'returnJson') ?? false;

  // Catch common parameter mistakes
  if ('folder' in args || 'folderId' in args) {
    const paramName = 'folder' in args ? 'folder' : 'folderId';
    const folderId = (args as unknown as Record<string, unknown>)[paramName];
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' should be inside 'options'. ` +
      `Example: { "email": "user@example.com", "options": { "folderId": "${folderId}" } }`
    );
  }

  if ('limit' in args || 'maxResults' in args || 'max_results' in args) {
    const paramName = 'limit' in args ? 'limit' : ('maxResults' in args ? 'maxResults' : 'max_results');
    const value = (args as unknown as Record<string, unknown>)[paramName];
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' should be 'pageSize' inside 'options'. ` +
      `Example: { "email": "user@example.com", "options": { "pageSize": ${value} } }`
    );
  }

  if ('query' in args) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: 'query' should be inside 'options'. ` +
      `Example: { "email": "user@example.com", "options": { "query": "${(args as unknown as Record<string, unknown>).query}" } }`
    );
  }
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.listFiles(email, args.options || {});
    
    // Return JSON if requested, otherwise format as human-readable text
    // Return string directly - server.ts handles MCP response wrapping
    if (returnJson) {
      return result;  // Server will JSON.stringify
    }
    
    // Format as text for better LLM consumption
    if (!result.success) {
      return `Error listing files: ${result.error || 'Unknown error'}`;
    }
    const files = result.data?.files || [];
    return formatFilesAsText(files);
  });
}

export async function handleSearchDriveFiles(args: DriveSearchArgs & Record<string, unknown>): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const returnJson = readAliasedBoolean(args, 'return_json', 'returnJson') ?? false;

  // Catch common parameter mistakes
  if ('query' in args || 'q' in args || 'search' in args) {
    const paramName = 'query' in args ? 'query' : ('q' in args ? 'q' : 'search');
    const searchQuery = (args as unknown as Record<string, unknown>)[paramName];
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' should be inside 'options'. ` +
      `Use 'options.fullText' for text search or 'options.query' for raw Drive query. ` +
      `Example: { "email": "user@example.com", "options": { "fullText": "${searchQuery}" } }`
    );
  }

  if ('folder' in args || 'folderId' in args) {
    const paramName = 'folder' in args ? 'folder' : 'folderId';
    const folderId = (args as unknown as Record<string, unknown>)[paramName];
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' should be inside 'options'. ` +
      `Example: { "email": "user@example.com", "options": { "folderId": "${folderId}" } }`
    );
  }

  if ('limit' in args || 'maxResults' in args || 'max_results' in args) {
    const paramName = 'limit' in args ? 'limit' : ('maxResults' in args ? 'maxResults' : 'max_results');
    const value = (args as unknown as Record<string, unknown>)[paramName];
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' should be 'pageSize' inside 'options'. ` +
      `Example: { "email": "user@example.com", "options": { "pageSize": ${value} } }`
    );
  }
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.searchFiles(email, args.options);
    
    // Return JSON if requested, otherwise format as human-readable text
    // Return string directly - server.ts handles MCP response wrapping
    if (returnJson) {
      return result;  // Server will JSON.stringify
    }
    
    // Format as text for better LLM consumption
    if (!result.success) {
      return `Error searching files: ${result.error || 'Unknown error'}`;
    }
    const files = result.data?.files || [];
    return formatFilesAsText(files);
  });
}

export async function handleUploadDriveFile(args: DriveUploadArgs): Promise<McpToolResponse> {
  if (!args.options?.name) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "options.name" (filename for upload). ' +
      'Example: { "email": "user@example.com", "options": { "name": "document.txt", "content": "file content here", "mimeType": "text/plain" } }'
    );
  }
  if (!args.options?.content) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "options.content" (file content as string or base64). ' +
      'Example: { "email": "user@example.com", "options": { "name": "document.txt", "content": "file content here" } }'
    );
  }

  const accountManager = getAccountManager();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.uploadFile(email, args.options);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

export async function handleDownloadDriveFile(args: DriveDownloadArgs): Promise<string> {
  const rawArgs = args as unknown as Record<string, unknown>;
  const fileId = readAliasedString(rawArgs, 'file_id', 'fileId');
  const mimeType = readAliasedString(rawArgs, 'mime_type', 'mimeType');

  if (!fileId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "file_id" (the Drive file ID to download). ' +
      'Example: { "email": "user@example.com", "file_id": "1ABC123xyz" }. ' +
      'Use list_drive_files or search_drive_files to find file IDs.'
    );
  }

  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.downloadFile(email, {
      fileId,
      mimeType
    });
    return JSON.stringify(result);
  });
}

export async function handleCreateDriveFolder(args: DriveFolderArgs): Promise<McpToolResponse> {
  const parentId = readAliasedString(args as unknown as Record<string, unknown>, 'parent_id', 'parentId');
  if (!args.name) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "name" (folder name to create). ' +
      'Example: { "email": "user@example.com", "name": "Project Files", "parent_id": "optional_parent_folder_id" }'
    );
  }

  const accountManager = getAccountManager();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.createFolder(email, args.name, parentId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

export async function handleUpdateDrivePermissions(args: DrivePermissionArgs): Promise<McpToolResponse> {
  if (!args.options?.fileId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "options.fileId" (the file/folder to share). ' +
      'Example: { "email": "user@example.com", "options": { "fileId": "1ABC123xyz", "role": "reader", "type": "user", "emailAddress": "collaborator@example.com" } }'
    );
  }
  if (!args.options?.role) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "options.role" (permission level). ' +
      'Valid roles: "owner", "organizer", "fileOrganizer", "writer", "commenter", "reader". ' +
      'Example: { "options": { "fileId": "...", "role": "writer", "type": "user", "emailAddress": "..." } }'
    );
  }
  if (!args.options?.type) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "options.type" (permission scope). ' +
      'Valid types: "user", "group", "domain", "anyone". ' +
      'For "user"/"group", also provide "emailAddress". For "domain", provide "domain".'
    );
  }

  const accountManager = getAccountManager();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.updatePermissions(email, args.options);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

export async function handleDeleteDriveFile(args: DriveDeleteArgs): Promise<McpToolResponse> {
  const fileId = readAliasedString(args as unknown as Record<string, unknown>, 'file_id', 'fileId');
  if (!fileId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "file_id" (the file/folder ID to delete). ' +
      'Example: { "email": "user@example.com", "file_id": "1ABC123xyz" }. ' +
      'WARNING: This permanently deletes the file. Use list_drive_files to find file IDs.'
    );
  }

  const accountManager = getAccountManager();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.deleteFile(email, fileId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

interface DriveCopyArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
  name?: string;
  parent_id?: string;
  parentId?: string;
}

export async function handleCopyDriveFile(args: DriveCopyArgs): Promise<McpToolResponse> {
  const rawArgs = args as unknown as Record<string, unknown>;
  const fileId = readAliasedString(rawArgs, 'file_id', 'fileId');
  const parentId = readAliasedString(rawArgs, 'parent_id', 'parentId');
  if (!fileId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "file_id" (the file ID to copy). ' +
      'Example: { "file_id": "1ABC123xyz", "name": "Copy of Document", "parent_id": "folder456" }. ' +
      'Use search_drive_files or list_drive_files to find file IDs.'
    );
  }

  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.copyFile(email, fileId, args.name, parentId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

interface DriveMoveArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
  new_parent_id?: string;
  newParentId?: string;
  remove_from_parents?: string;
  removeFromParents?: string;
}

export async function handleMoveDriveFile(args: DriveMoveArgs): Promise<McpToolResponse> {
  const rawArgs = args as unknown as Record<string, unknown>;
  const fileId = readAliasedString(rawArgs, 'file_id', 'fileId');
  const newParentId = readAliasedString(rawArgs, 'new_parent_id', 'newParentId');
  const removeFromParents = readAliasedString(rawArgs, 'remove_from_parents', 'removeFromParents');
  if (!fileId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "file_id" (the file ID to move). ' +
      'Example: { "file_id": "1ABC123xyz", "new_parent_id": "folder456" }.'
    );
  }
  if (!newParentId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "new_parent_id" (the destination folder ID). ' +
      'Example: { "file_id": "1ABC123xyz", "new_parent_id": "folder456" }. ' +
      'Use list_drive_files to find folder IDs.'
    );
  }

  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    // Default to '*' (move from all parents) unless explicitly set to something else
    const effectiveRemoveFromParents = removeFromParents !== undefined ? removeFromParents : '*';
    const result = await driveService.moveFile(email, fileId, newParentId, effectiveRemoveFromParents);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

interface DriveTrashArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
}

export async function handleTrashDriveFile(args: DriveTrashArgs): Promise<McpToolResponse> {
  const fileId = readAliasedString(args as unknown as Record<string, unknown>, 'file_id', 'fileId');
  if (!fileId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "file_id" (the file ID to trash). ' +
      'Example: { "file_id": "1ABC123xyz" }. ' +
      'Use search_drive_files or list_drive_files to find file IDs.'
    );
  }

  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.trashFile(email, fileId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

export async function handleUntrashDriveFile(args: DriveTrashArgs): Promise<McpToolResponse> {
  const fileId = readAliasedString(args as unknown as Record<string, unknown>, 'file_id', 'fileId');
  if (!fileId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "file_id" (the file ID to restore from trash). ' +
      'Example: { "file_id": "1ABC123xyz" }. ' +
      'Use search_drive_files with { "options": { "trashed": true } } to find trashed files.'
    );
  }

  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.untrashFile(email, fileId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

interface DriveRevisionsArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
}

export async function handleListFileRevisions(args: DriveRevisionsArgs): Promise<McpToolResponse> {
  const fileId = readAliasedString(args as unknown as Record<string, unknown>, 'file_id', 'fileId');
  if (!fileId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "file_id" (the file ID to list revisions for). ' +
      'Example: { "file_id": "1ABC123xyz" }. ' +
      'Use search_drive_files or list_drive_files to find file IDs.'
    );
  }

  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.listRevisions(email, fileId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

interface DriveDownloadRevisionArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
  revision_id?: string;
  revisionId?: string;
}

export async function handleDownloadFileRevision(args: DriveDownloadRevisionArgs): Promise<string> {
  const rawArgs = args as unknown as Record<string, unknown>;
  const fileId = readAliasedString(rawArgs, 'file_id', 'fileId');
  const revisionId = readAliasedString(rawArgs, 'revision_id', 'revisionId');
  if (!fileId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "file_id" (the file ID). ' +
      'Example: { "file_id": "1ABC123xyz", "revision_id": "r456" }.'
    );
  }
  if (!revisionId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "revision_id" (the revision ID). ' +
      'Example: { "file_id": "1ABC123xyz", "revision_id": "r456" }.' +
      'Use list_file_revisions to find revision IDs.'
    );
  }

  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const driveService = await getDriveService();
    const result = await driveService.downloadRevision(email, fileId, revisionId);
    return JSON.stringify(result);
  });
}
