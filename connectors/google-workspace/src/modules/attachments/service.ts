import {
  AttachmentMetadata,
  AttachmentResult,
  AttachmentServiceConfig,
  AttachmentSource,
  AttachmentValidationResult,
  ATTACHMENT_FOLDERS,
  AttachmentFolderType
} from './types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

// Determine default attachment path based on environment
function getDefaultAttachmentPath(): string {
  const workspaceRoot = process.env.MCP_WORKSPACE_PATH || process.env.WORKSPACE_BASE_PATH;
  if (workspaceRoot) {
    return path.join(workspaceRoot, ATTACHMENT_FOLDERS.ROOT);
  }
  // Default: use OS temp directory for ephemeral attachment storage
  return path.join(os.tmpdir(), 'google-workspace-mcp', ATTACHMENT_FOLDERS.ROOT);
}

function isPathInsideDirectory(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

const DEFAULT_CONFIG: AttachmentServiceConfig = {
  maxSizeBytes: 25 * 1024 * 1024, // 25MB
  allowedMimeTypes: ['*/*'],
  quotaLimitBytes: 1024 * 1024 * 1024 // 1GB
};

export class AttachmentService {
  private static instance: AttachmentService;
  private config: AttachmentServiceConfig;
  private initialized = false;

  private constructor(config: AttachmentServiceConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      basePath: config.basePath ?? getDefaultAttachmentPath()
    };
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(config: AttachmentServiceConfig = {}): AttachmentService {
    if (!AttachmentService.instance) {
      AttachmentService.instance = new AttachmentService(config);
    }
    return AttachmentService.instance;
  }

  /**
   * Initialize attachment folders in local storage
   */
  async initialize(email: string): Promise<void> {
    try {
      // Create base attachment directory
      await fs.mkdir(this.config.basePath!, { recursive: true });

      // Create email directory structure
      const emailPath = path.join(this.config.basePath!, ATTACHMENT_FOLDERS.EMAIL);
      await fs.mkdir(emailPath, { recursive: true });
      await fs.mkdir(path.join(emailPath, ATTACHMENT_FOLDERS.INCOMING), { recursive: true });
      await fs.mkdir(path.join(emailPath, ATTACHMENT_FOLDERS.OUTGOING), { recursive: true });

      // Create calendar directory structure
      const calendarPath = path.join(this.config.basePath!, ATTACHMENT_FOLDERS.CALENDAR);
      await fs.mkdir(calendarPath, { recursive: true });
      await fs.mkdir(path.join(calendarPath, ATTACHMENT_FOLDERS.EVENT_FILES), { recursive: true });

      this.initialized = true;
    } catch (error) {
      throw new Error(`Failed to initialize attachment directories: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate attachment against configured limits
   */
  private validateAttachment(source: AttachmentSource): AttachmentValidationResult {
    // Check size if available
    if (source.metadata.size && this.config.maxSizeBytes) {
      if (source.metadata.size > this.config.maxSizeBytes) {
        return {
          valid: false,
          error: `File size ${source.metadata.size} exceeds maximum allowed size ${this.config.maxSizeBytes}`
        };
      }
    }

    // Check MIME type if restricted
    if (this.config.allowedMimeTypes && 
        this.config.allowedMimeTypes[0] !== '*/*' &&
        !this.config.allowedMimeTypes.includes(source.metadata.mimeType)) {
      return {
        valid: false,
        error: `MIME type ${source.metadata.mimeType} is not allowed`
      };
    }

    return { valid: true };
  }

  /**
   * Process attachment and store in local filesystem
   */
  async processAttachment(
    email: string,
    source: AttachmentSource,
    parentFolder: string
  ): Promise<AttachmentResult> {
    if (!this.initialized) {
      await this.initialize(email);
    }

    // Validate attachment
    const validation = this.validateAttachment(source);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error
      };
    }

    try {
      if (!source.content) {
        throw new Error('File content not provided');
      }

      // Generate unique ID and create file path
      const id = uuidv4();
      const folderPath = path.join(this.config.basePath!, parentFolder);
      const filePath = path.join(folderPath, `${id}_${source.metadata.name}`);

      // Write file content
      const content = Buffer.from(source.content, 'base64');
      await fs.writeFile(filePath, content);

      // Get actual file size
      const stats = await fs.stat(filePath);

      return {
        success: true,
        attachment: {
          id,
          name: source.metadata.name,
          mimeType: source.metadata.mimeType,
          size: stats.size,
          path: filePath
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Download attachment from local storage
   */
  async downloadAttachment(
    email: string,
    attachmentId: string,
    filePath: string
  ): Promise<AttachmentResult> {
    if (!this.initialized) {
      await this.initialize(email);
    }

    try {
      const safeFilePath = await this.resolveContainedAttachmentPath(filePath);

      const content = await fs.readFile(safeFilePath);
      const stats = await fs.stat(safeFilePath);

      return {
        success: true,
        attachment: {
          id: attachmentId,
          name: path.basename(safeFilePath).substring(37), // Remove UUID prefix
          mimeType: path.extname(safeFilePath) ?
            `application/${path.extname(safeFilePath).substring(1)}` :
            'application/octet-stream',
          size: stats.size,
          path: safeFilePath
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Delete attachment from local storage
   */
  async deleteAttachment(
    email: string,
    attachmentId: string,
    filePath: string
  ): Promise<AttachmentResult> {
    if (!this.initialized) {
      await this.initialize(email);
    }

    try {
      const safeFilePath = await this.resolveContainedAttachmentPath(filePath);

      // Get file stats before deletion
      const stats = await fs.stat(safeFilePath);
      const name = path.basename(safeFilePath).substring(37); // Remove UUID prefix
      const mimeType = path.extname(safeFilePath) ?
        `application/${path.extname(safeFilePath).substring(1)}` :
        'application/octet-stream';

      // Delete the file
      await fs.unlink(safeFilePath);

      return {
        success: true,
        attachment: {
          id: attachmentId,
          name,
          mimeType,
          size: stats.size,
          path: safeFilePath
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Get full path for a specific attachment category
   */
  getAttachmentPath(folder: AttachmentFolderType): string {
    return path.join(this.config.basePath!, folder);
  }

  private async resolveContainedAttachmentPath(filePath: string): Promise<string> {
    const basePath = this.config.basePath;
    if (!basePath) {
      throw new Error('Attachment base path is not configured');
    }

    const baseStats = await fs.lstat(basePath);
    if (baseStats.isSymbolicLink() || !baseStats.isDirectory()) {
      throw new Error('Attachment base path must be a real directory');
    }

    const candidateStats = await fs.lstat(filePath);
    if (candidateStats.isSymbolicLink()) {
      throw new Error('Attachment path must not be a symbolic link');
    }

    const rootRealpath = await fs.realpath(basePath);
    const candidateRealpath = await fs.realpath(filePath);
    if (!isPathInsideDirectory(candidateRealpath, rootRealpath)) {
      throw new Error('Invalid file path');
    }

    return candidateRealpath;
  }

  /**
   * Find attachment in local storage by scanning filesystem for matching filename.
   * Files are stored as ${uuid}_${filename}, so we search for files ending with _${filename}
   */
  async findAttachmentByFilename(
    email: string,
    filename: string,
    folder: AttachmentFolderType
  ): Promise<AttachmentResult> {
    if (!this.initialized) {
      await this.initialize(email);
    }

    try {
      const folderPath = path.join(this.config.basePath!, folder);

      let files: string[];
      try {
        files = await fs.readdir(folderPath);
      } catch {
        return {
          success: false,
          error: 'Attachment folder does not exist'
        };
      }

      // Sanitize filename to prevent path traversal
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return { success: false, error: 'Invalid filename' };
      }

      // Case-insensitive match for consistency with Gmail API behavior
      const filenameLower = filename.toLowerCase();
      const matchingFile = files.find(f => f.toLowerCase().endsWith(`_${filenameLower}`));

      if (!matchingFile) {
        return {
          success: false,
          error: `Attachment "${filename}" not found in local storage`
        };
      }

      const filePath = path.join(folderPath, matchingFile);
      const stats = await fs.stat(filePath);
      const extractedId = matchingFile.substring(0, 36); // UUID is 36 chars
      const mimeType = path.extname(filename) ?
        `application/${path.extname(filename).substring(1)}` :
        'application/octet-stream';

      return {
        success: true,
        attachment: {
          id: extractedId,
          name: filename,
          mimeType,
          size: stats.size,
          path: filePath
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Delete attachment by scanning filesystem for matching filename.
   * Files are stored as ${uuid}_${filename}, so we search for files ending with _${filename}
   */
  async deleteAttachmentByFilename(
    email: string,
    filename: string,
    folder: AttachmentFolderType
  ): Promise<AttachmentResult> {
    if (!this.initialized) {
      await this.initialize(email);
    }

    try {
      const folderPath = path.join(this.config.basePath!, folder);
      
      // List files in the folder
      let files: string[];
      try {
        files = await fs.readdir(folderPath);
      } catch {
        return {
          success: false,
          error: 'Attachment folder does not exist'
        };
      }

      // Find file matching pattern: *_${filename}
      const matchingFile = files.find(f => f.endsWith(`_${filename}`));
      
      if (!matchingFile) {
        return {
          success: false,
          error: `Attachment "${filename}" not found in local storage`
        };
      }

      const filePath = path.join(folderPath, matchingFile);
      
      // Get file stats before deletion
      const stats = await fs.stat(filePath);
      const extractedId = matchingFile.substring(0, 36); // UUID is 36 chars
      const mimeType = path.extname(filename) ? 
        `application/${path.extname(filename).substring(1)}` : 
        'application/octet-stream';

      // Delete the file
      await fs.unlink(filePath);

      return {
        success: true,
        attachment: {
          id: extractedId,
          name: filename,
          mimeType,
          size: stats.size,
          path: filePath
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }
}
