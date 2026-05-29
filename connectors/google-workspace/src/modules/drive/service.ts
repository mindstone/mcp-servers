import { google } from 'googleapis';
import { BaseGoogleService } from '../../services/base/BaseGoogleService.js';
import { DriveOperationResult, FileDownloadOptions, FileListOptions, FileSearchOptions, FileUploadOptions, PermissionOptions } from './types.js';
import { Readable } from 'stream';
import { DRIVE_SCOPES } from './scopes.js';
import { GaxiosResponse } from 'gaxios';

const MAX_INLINE_BINARY_BYTES = 500 * 1024; // 500KB

const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
  'application/csv',
  'application/sql',
  'application/graphql',
  'application/x-sh',
  'application/xhtml+xml',
  'application/x-httpd-php',
]);

function isTextMimeType(mime: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (TEXT_APPLICATION_TYPES.has(mime)) return true;
  if (mime.endsWith('+json') || mime.endsWith('+xml') || mime.endsWith('+yaml')) return true;
  return false;
}

function decodeContent(data: Uint8Array, mimeType: string): { content: string; encoding: 'text' | 'base64' } {
  if (isTextMimeType(mimeType)) {
    return { content: new TextDecoder().decode(data), encoding: 'text' };
  }
  return { content: Buffer.from(data).toString('base64'), encoding: 'base64' };
}

/**
 * Escape single quotes in Drive query values to prevent injection.
 */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class DriveService extends BaseGoogleService<ReturnType<typeof google.drive>> {
  private initialized = false;

  constructor() {
    super({
      serviceName: 'Google Drive',
      version: 'v3'
    });
  }

  /**
   * Initialize the Drive service and all dependencies
   */
  public async initialize(): Promise<void> {
    try {
      await super.initialize();
      this.initialized = true;
    } catch (error) {
      throw this.handleError(error, 'Failed to initialize Drive service');
    }
  }

  /**
   * Ensure the Drive service is initialized
   */
  public async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Check if the service is initialized
   */
  private checkInitialized(): void {
    if (!this.initialized) {
      throw this.handleError(
        new Error('Drive service not initialized'),
        'Please ensure the service is initialized before use'
      );
    }
  }

  async listFiles(email: string, options: FileListOptions = {}): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.READONLY]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const query = [];
      if (options.folderId) {
        const safeFolderId = escapeDriveQueryValue(options.folderId);
        query.push(`'${safeFolderId}' in parents`);
      }
      if (options.query) {
        query.push(options.query);
      }

      const response = await client.files.list({
        q: query.join(' and ') || undefined,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        orderBy: options.orderBy?.join(','),
        fields: options.fields?.join(',') || 'files(id, name, mimeType, modifiedTime, size)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to list Drive files');
    }
  }

  async uploadFile(email: string, options: FileUploadOptions): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const contentBuffer = Buffer.from(options.content);
      const media = {
        mimeType: options.mimeType || 'application/octet-stream',
        body: Readable.from([contentBuffer]),
      };

      const response = await client.files.create({
        requestBody: {
          name: options.name,
          mimeType: options.mimeType,
          parents: options.parents,
        },
        media,
        fields: 'id, name, mimeType, webViewLink',
        supportsAllDrives: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to upload Drive file');
    }
  }

  async downloadFile(email: string, options: FileDownloadOptions): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.READONLY]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const file = await client.files.get({
        fileId: options.fileId,
        fields: 'name,mimeType',
        supportsAllDrives: true,
      });

      const fileName = file.data.name || options.fileId;

      // Handle Google Workspace files (export to requested or default format)
      if (file.data.mimeType?.startsWith('application/vnd.google-apps')) {
        let exportMimeType = options.mimeType || 'text/plain';
        
        if (!options.mimeType) {
          switch (file.data.mimeType) {
            case 'application/vnd.google-apps.document':
              exportMimeType = 'text/markdown';
              break;
            case 'application/vnd.google-apps.spreadsheet':
              exportMimeType = 'text/csv';
              break;
            case 'application/vnd.google-apps.presentation':
              exportMimeType = 'text/plain';
              break;
            case 'application/vnd.google-apps.drawing':
              exportMimeType = 'image/png';
              break;
          }
        }

        // Note: files.export does NOT accept supportsAllDrives — Workspace export
        // only applies to native Google Docs/Sheets/Slides, and the parent file.get
        // above already used supportsAllDrives so we know the file is accessible.
        const response = await client.files.export({
          fileId: options.fileId,
          mimeType: exportMimeType,
        }, {
          responseType: 'arraybuffer'
        }) as unknown as GaxiosResponse<Uint8Array>;

        if (!isTextMimeType(exportMimeType) && response.data.byteLength > MAX_INLINE_BINARY_BYTES) {
          return {
            success: true,
            fileName,
            mimeType: exportMimeType,
            encoding: 'base64',
            data: null,
            error: `File too large for inline content (${response.data.byteLength} bytes). Export as a text format instead.`,
          };
        }

        const { content, encoding } = decodeContent(response.data, exportMimeType);
        return { success: true, data: content, mimeType: exportMimeType, encoding, fileName };
      }

      // Regular files
      const nativeMime = file.data.mimeType || 'application/octet-stream';
      const response = await client.files.get({
        fileId: options.fileId,
        alt: 'media',
        supportsAllDrives: true,
      }, {
        responseType: 'arraybuffer'
      }) as unknown as GaxiosResponse<Uint8Array>;

      if (!isTextMimeType(nativeMime) && response.data.byteLength > MAX_INLINE_BINARY_BYTES) {
        return {
          success: true,
          fileName,
          mimeType: nativeMime,
          encoding: 'base64',
          data: null,
          error: `Binary file too large for inline content (${response.data.byteLength} bytes).`,
        };
      }

      const { content, encoding } = decodeContent(response.data, nativeMime);
      return { success: true, data: content, mimeType: nativeMime, encoding, fileName };
    } catch (error) {
      throw this.handleError(error, 'Failed to download Drive file');
    }
  }

  async createFolder(email: string, name: string, parentId?: string): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const response = await client.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: parentId ? [parentId] : undefined,
        },
        fields: 'id, name, mimeType, webViewLink',
        supportsAllDrives: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to create Drive folder');
    }
  }

  async searchFiles(email: string, options: FileSearchOptions): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.READONLY]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const query = [];
      
      if (options.fullText) {
        const escapedQuery = escapeDriveQueryValue(options.fullText);
        query.push(`fullText contains '${escapedQuery}'`);
      }
      if (options.mimeType) {
        const safeMimeType = escapeDriveQueryValue(options.mimeType);
        query.push(`mimeType = '${safeMimeType}'`);
      }
      if (options.folderId) {
        const safeFolderId = escapeDriveQueryValue(options.folderId);
        query.push(`'${safeFolderId}' in parents`);
      }
      if (options.trashed !== undefined) {
        query.push(`trashed = ${options.trashed}`);
      }
      if (options.query) {
        query.push(options.query);
      }

      const response = await client.files.list({
        q: query.join(' and ') || undefined,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        orderBy: options.orderBy?.join(','),
        fields: options.fields?.join(',') || 'files(id, name, mimeType, modifiedTime, size)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to search Drive files');
    }
  }

  async updatePermissions(email: string, options: PermissionOptions): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const response = await client.permissions.create({
        fileId: options.fileId,
        requestBody: {
          role: options.role,
          type: options.type,
          emailAddress: options.emailAddress,
          domain: options.domain,
          allowFileDiscovery: options.allowFileDiscovery,
        },
        supportsAllDrives: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to update Drive permissions');
    }
  }

  async deleteFile(email: string, fileId: string): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      await client.files.delete({
        fileId,
        supportsAllDrives: true,
      });

      return {
        success: true,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to delete Drive file');
    }
  }

  async copyFile(email: string, fileId: string, name?: string, parentId?: string): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const response = await client.files.copy({
        fileId,
        requestBody: {
          name,
          parents: parentId ? [parentId] : undefined,
        },
        fields: 'id, name, mimeType, webViewLink, parents',
        supportsAllDrives: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to copy Drive file');
    }
  }

  async moveFile(email: string, fileId: string, newParentId: string, removeFromParents?: string): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      // If removeFromParents not specified, fetch current parents to do a true "move"
      let parentsToRemove = removeFromParents;
      if (!parentsToRemove) {
        const fileInfo = await client.files.get({
          fileId,
          fields: 'parents',
          supportsAllDrives: true,
        });
        parentsToRemove = fileInfo.data.parents?.join(',') || '';
      }

      const response = await client.files.update({
        fileId,
        addParents: newParentId,
        removeParents: parentsToRemove || undefined,
        fields: 'id, name, mimeType, webViewLink, parents',
        supportsAllDrives: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to move Drive file');
    }
  }

  async trashFile(email: string, fileId: string): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const response = await client.files.update({
        fileId,
        requestBody: {
          trashed: true,
        },
        fields: 'id, name, mimeType, trashed',
        supportsAllDrives: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to trash Drive file');
    }
  }

  async untrashFile(email: string, fileId: string): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const response = await client.files.update({
        fileId,
        requestBody: {
          trashed: false,
        },
        fields: 'id, name, mimeType, trashed, webViewLink, parents',
        supportsAllDrives: true,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to untrash Drive file');
    }
  }

  async listRevisions(email: string, fileId: string): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const response = await client.revisions.list({
        fileId,
        fields: 'revisions(id, mimeType, modifiedTime, lastModifyingUser, size, keepForever, published)',
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      throw this.handleError(error, 'Failed to list Drive file revisions');
    }
  }

  async downloadRevision(email: string, fileId: string, revisionId: string): Promise<DriveOperationResult> {
    try {
      await this.ensureInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FILE]);
      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.drive({ version: 'v3', auth })
      );

      const fileInfo = await client.files.get({
        fileId,
        fields: 'name',
        supportsAllDrives: true,
      });
      const fileName = fileInfo.data.name || fileId;

      const revisionMeta = await client.revisions.get({
        fileId,
        revisionId,
        fields: 'id, mimeType, size',
      });

      const response = await client.revisions.get({
        fileId,
        revisionId,
        alt: 'media',
      }, {
        responseType: 'arraybuffer',
      }) as unknown as GaxiosResponse<Uint8Array>;

      const revMime = revisionMeta.data.mimeType || 'application/octet-stream';

      if (!isTextMimeType(revMime) && response.data.byteLength > MAX_INLINE_BINARY_BYTES) {
        return {
          success: true,
          fileName,
          mimeType: revMime,
          encoding: 'base64',
          data: null,
          error: `Binary revision too large for inline content (${response.data.byteLength} bytes).`,
        };
      }

      const { content, encoding } = decodeContent(response.data, revMime);
      return { success: true, data: content, mimeType: revMime, encoding, fileName };
    } catch (error) {
      throw this.handleError(error, 'Failed to download Drive file revision');
    }
  }
}
