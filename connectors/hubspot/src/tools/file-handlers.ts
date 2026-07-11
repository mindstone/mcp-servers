import { readFile, stat, realpath } from 'node:fs/promises';
import path, { basename } from 'node:path';
import { getHubSpotClientAsync, HubSpotApiError } from '../api/hubspot-client.js';
import {
  buildHubSpotCapabilityDeniedError,
  parseHubSpotError as parseSharedHubSpotError,
  summariseHubSpotApiError,
  type ParsedHubSpotError,
} from '../utils/error-parser.js';
import { injectHostMetadata } from '../utils/user-context.js';
import logger from '../utils/logger.js';
import {
  assertAssociationFanOut,
  assertStringBodySize,
} from './input-limits.js';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const WORKSPACE_ENV_VAR = 'MCP_WORKSPACE_PATH';

function isPathInsideDirectory(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

async function getWorkspaceRootPath(): Promise<string> {
  const workspacePath = process.env[WORKSPACE_ENV_VAR];
  if (!workspacePath) {
    throw new Error(JSON.stringify({
      error: `${WORKSPACE_ENV_VAR} is required for HubSpot file tools.`,
      errorCode: 'WORKSPACE_PATH_REQUIRED',
      suggestion: `Set ${WORKSPACE_ENV_VAR} to your workspace root before using file tools.`
    }));
  }

  try {
    return await realpath(path.resolve(workspacePath));
  } catch {
    throw new Error(JSON.stringify({
      error: `${WORKSPACE_ENV_VAR} does not resolve to an accessible directory.`,
      errorCode: 'WORKSPACE_PATH_INVALID',
      suggestion: `Verify ${WORKSPACE_ENV_VAR} points to a valid workspace directory.`
    }));
  }
}

async function assertWorkspaceContainedFilePath(filePath: string): Promise<string> {
  const workspaceRoot = await getWorkspaceRootPath();
  const resolvedFilePath = await realpath(path.resolve(filePath));

  if (!isPathInsideDirectory(resolvedFilePath, workspaceRoot)) {
    throw new Error(JSON.stringify({
      error: `File path is outside ${WORKSPACE_ENV_VAR}: ${filePath}`,
      errorCode: 'PATH_OUTSIDE_WORKSPACE',
      suggestion: `Use a file inside ${workspaceRoot}.`
    }));
  }

  return resolvedFilePath;
}

function parseFileError(error: unknown, operation: string): ParsedHubSpotError {
  const sharedParsed = parseSharedHubSpotError(error, {
    objectType: 'files',
    operation,
    args: { operation },
  });
  if (
    'status' in sharedParsed ||
    sharedParsed.errorCode === 'REFRESH_TRANSIENT' ||
    sharedParsed.errorCode === 'REFRESH_RATE_LIMITED' ||
    sharedParsed.errorCode === 'REFRESH_MALFORMED_RESPONSE' ||
    sharedParsed.errorCode === 'REFRESH_LOCK_FAILED' ||
    sharedParsed.errorCode === 'TOKEN_PERSIST_FAILED'
  ) {
    return sharedParsed;
  }

  if (error instanceof HubSpotApiError) {
    if (error.statusCode === 401) {
      return { error: 'HubSpot authentication expired', errorCode: 'AUTH_EXPIRED', suggestion: 'Call list_hubspot_accounts then authenticate_hubspot_account.' };
    }
    if (error.statusCode === 403) {
      const capabilityDenied = buildHubSpotCapabilityDeniedError({
        objectType: 'files',
        operation,
        args: { operation },
      });

      return {
        error: capabilityDenied.error,
        errorCode: 'PERMISSION_DENIED',
        suggestion: capabilityDenied.suggestion,
        // Carries any scope(s) HubSpot named (requiredScopes) for log-based diagnosis.
        details: summariseHubSpotApiError(error, { operation })
      };
    }
    if (error.statusCode === 404) {
      return { error: 'File not found', errorCode: 'NOT_FOUND', suggestion: 'Verify the file ID is correct.' };
    }
    if (error.statusCode === 408) {
      return { error: error.message, errorCode: 'IMPORT_TIMEOUT', suggestion: 'The file import is still processing. Try again later or use a smaller file.' };
    }
    if (error.statusCode === 429) {
      return { error: 'Rate limited', errorCode: 'RATE_LIMITED', suggestion: 'Wait a few seconds and retry.' };
    }
    return {
      error: 'HubSpot files API error',
      errorCode: 'API_ERROR',
      suggestion: 'Check HubSpot connection and try again.',
      details: summariseHubSpotApiError(error, { operation })
    };
  }
  const msg = error instanceof Error ? error.message : 'Unknown error';
  if (msg.includes('ENOENT') || msg.includes('no such file')) {
    return { error: `File not found: ${msg}`, errorCode: 'FILE_NOT_FOUND', suggestion: 'Check the file path exists and is accessible.' };
  }
  return sharedParsed.errorCode === 'UNKNOWN_ERROR'
    ? { error: msg, errorCode: 'UNKNOWN_ERROR', suggestion: `Check inputs for ${operation} and try again.` }
    : sharedParsed;
}

function isStructuredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const parsed = JSON.parse(error.message);
    return typeof parsed === 'object' && parsed !== null && 'errorCode' in parsed;
  } catch {
    return false;
  }
}

function extractUrlFilename(fileUrl: string): string {
  try {
    const pathname = new URL(fileUrl).pathname;
    return basename(pathname) || 'imported-file';
  } catch {
    return fileUrl.split('/').pop()?.split('?')[0] || 'imported-file';
  }
}

export interface UploadFileArgs {
  filePath: string;
  folderPath?: string;
  access?: 'PRIVATE' | 'PUBLIC_NOT_INDEXABLE' | 'PUBLIC_INDEXABLE';
}

export async function handleUploadFile(args: UploadFileArgs) {
  try {
    const resolvedFilePath = await assertWorkspaceContainedFilePath(args.filePath);
    const fileInfo = await stat(resolvedFilePath);
    if (fileInfo.size > MAX_FILE_SIZE) {
      throw new Error(JSON.stringify({
        error: `File too large (${(fileInfo.size / 1024 / 1024).toFixed(1)}MB). Maximum is 100MB.`,
        errorCode: 'FILE_TOO_LARGE',
        suggestion: 'Use a smaller file or compress it before uploading.'
      }));
    }

    const client = await getHubSpotClientAsync();
    const fileBuffer = await readFile(resolvedFilePath);
    const fileName = basename(resolvedFilePath);

    const result = await client.uploadFile(fileBuffer, fileName, {
      folderPath: args.folderPath,
      access: args.access
    });

    logger.info(`Uploaded file "${fileName}" → id=${result.id}`);
    return result;
  } catch (error) {
    if (isStructuredError(error)) throw error;
    const parsed = parseFileError(error, 'upload_file');
    logger.error('Upload file failed:', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export interface ImportFileFromUrlArgs {
  url: string;
  fileName?: string;
  folderPath?: string;
  access?: 'PRIVATE' | 'PUBLIC_NOT_INDEXABLE' | 'PUBLIC_INDEXABLE';
}

export async function handleImportFileFromUrl(args: ImportFileFromUrlArgs) {
  try {
    await getWorkspaceRootPath();
    const client = await getHubSpotClientAsync();

    const result = await client.importFileFromUrlAndWait(args.url, {
      folderPath: args.folderPath,
      fileName: args.fileName,
      access: args.access
    });

    logger.info(`Imported file from URL → id=${result.id}, name=${result.name}`);
    return result;
  } catch (error) {
    if (isStructuredError(error)) throw error;
    const parsed = parseFileError(error, 'import_file_from_url');
    logger.error('Import file from URL failed:', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export interface GetFileArgs {
  fileId: string;
  getSignedUrl?: boolean;
}

export async function handleGetFile(args: GetFileArgs) {
  try {
    const client = await getHubSpotClientAsync();
    const file = await client.getFile(args.fileId);

    if (args.getSignedUrl) {
      try {
        const signed = await client.getFileSignedUrl(args.fileId);
        return { ...file, signedUrl: signed.url };
      } catch (signedError) {
        logger.warn(`Failed to get signed URL for file ${args.fileId}:`, signedError);
        return { ...file, signedUrl: null, signedUrlError: 'Could not generate signed URL (file may be public)' };
      }
    }

    return file;
  } catch (error) {
    if (isStructuredError(error)) throw error;
    const parsed = parseFileError(error, 'get_file');
    logger.error(`Get file ${args.fileId} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export interface DeleteFileArgs {
  fileId: string;
}

export async function handleDeleteFile(args: DeleteFileArgs) {
  try {
    const client = await getHubSpotClientAsync();
    await client.deleteFile(args.fileId);
    logger.info(`Deleted file ${args.fileId}`);
    return { success: true, message: `File ${args.fileId} deleted` };
  } catch (error) {
    if (isStructuredError(error)) throw error;
    const parsed = parseFileError(error, 'delete_file');
    logger.error(`Delete file ${args.fileId} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export interface AttachFileToRecordArgs {
  filePath?: string;
  fileUrl?: string;
  noteBody?: string;
  associations: {
    contactIds?: string[];
    companyIds?: string[];
    dealIds?: string[];
    ticketIds?: string[];
  };
}

export async function handleAttachFileToRecord(args: AttachFileToRecordArgs) {
  try {
    await getWorkspaceRootPath();

    if (!args.filePath && !args.fileUrl) {
      throw new Error(JSON.stringify({
        error: 'Either filePath or fileUrl is required',
        errorCode: 'MISSING_INPUT',
        suggestion: 'Provide filePath for a local file or fileUrl for a remote file.'
      }));
    }

    const { contactIds, companyIds, dealIds, ticketIds } = args.associations;
    assertAssociationFanOut(args.associations);
    assertStringBodySize(args.noteBody, 'noteBody');

    if (!contactIds?.length && !companyIds?.length && !dealIds?.length && !ticketIds?.length) {
      throw new Error(JSON.stringify({
        error: 'At least one association is required',
        errorCode: 'MISSING_ASSOCIATIONS',
        suggestion: 'Provide at least one of contactIds, companyIds, dealIds, or ticketIds.'
      }));
    }

    const client = await getHubSpotClientAsync();

    let fileId: string;
    let fileName: string;

    if (args.filePath) {
      const resolvedFilePath = await assertWorkspaceContainedFilePath(args.filePath);
      const fileInfo = await stat(resolvedFilePath);
      if (fileInfo.size > MAX_FILE_SIZE) {
        throw new Error(JSON.stringify({
          error: `File too large (${(fileInfo.size / 1024 / 1024).toFixed(1)}MB). Maximum is 100MB.`,
          errorCode: 'FILE_TOO_LARGE',
          suggestion: 'Use a smaller file or compress it before uploading.'
        }));
      }
      const fileBuffer = await readFile(resolvedFilePath);
      fileName = basename(resolvedFilePath);
      const uploaded = await client.uploadFile(fileBuffer, fileName, {
        folderPath: '/attachments',
        access: 'PRIVATE'
      });
      fileId = uploaded.id;
      logger.info(`Uploaded file "${fileName}" → id=${fileId}`);
    } else {
      fileName = extractUrlFilename(args.fileUrl!);
      const imported = await client.importFileFromUrlAndWait(args.fileUrl!, {
        folderPath: '/attachments',
        fileName,
        access: 'PRIVATE'
      });
      fileId = imported.id;
      logger.info(`Imported file from URL → id=${fileId}`);
    }

    const noteProperties: Record<string, string> = {
      hs_note_body: args.noteBody || `Attached file: ${fileName}`,
      hs_timestamp: new Date().toISOString(),
      hs_attachment_ids: fileId
    };

    const enrichedNoteProperties = await injectHostMetadata(noteProperties, 'notes');
    const note = await client.createObject('notes', enrichedNoteProperties);
    logger.info(`Created note ${note.id} with attachment ${fileId}`);

    const associationPromises: Promise<void>[] = [];

    if (contactIds) {
      for (const id of contactIds) {
        associationPromises.push(client.createAssociation('notes', note.id, 'contacts', id, 'note_to_contact'));
      }
    }
    if (companyIds) {
      for (const id of companyIds) {
        associationPromises.push(client.createAssociation('notes', note.id, 'companies', id, 'note_to_company'));
      }
    }
    if (dealIds) {
      for (const id of dealIds) {
        associationPromises.push(client.createAssociation('notes', note.id, 'deals', id, 'note_to_deal'));
      }
    }
    if (ticketIds) {
      for (const id of ticketIds) {
        associationPromises.push(client.createAssociation('notes', note.id, 'tickets', id, 'note_to_ticket'));
      }
    }

    await Promise.all(associationPromises);

    return {
      fileId,
      noteId: note.id,
      fileName,
      associations: args.associations
    };
  } catch (error) {
    if (isStructuredError(error)) throw error;
    const parsed = parseFileError(error, 'attach_file_to_record');
    logger.error('Attach file to record failed:', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}
