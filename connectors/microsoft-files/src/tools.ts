import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callGraph } from './client.js';
import { errorResponse, successJson, withErrorHandling } from './utils.js';
import {
  copyFile,
  createFolder,
  deleteFile,
  downloadFile,
  getFile,
  getRecent,
  getShared,
  listFiles,
  moveFile,
  readTextFile,
  searchFiles,
  shareFile,
  uploadFile,
} from './files.js';

const LinkTypeEnum = z.enum(['view', 'edit']);
const LinkScopeEnum = z.enum(['anonymous', 'organization']);

export function registerFilesTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // list_files
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_files',
    {
      description: 'List files and folders in OneDrive. Defaults to root folder.',
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe('Folder path (e.g., "/Documents") or item ID'),
        top: z.number().optional().describe('Max items to return (default: 50)'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      const result = await callGraph(extra, (c, signal) =>
        listFiles(c, { path: args.path, top: args.top }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // get_file
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_file',
    {
      description: 'Get metadata for a specific file or folder.',
      inputSchema: z.object({
        path: z.string().optional().describe('File path or item ID'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.path) {
        return errorResponse({
          error:
            'Missing required parameter: "path" (file path or ID). Example: { "path": "/Documents/report.docx" } or { "path": "01ABC123xyz" }. Use list_files to browse files.',
          action_required: 'Provide the file path or item ID.',
          next_step: 'list_files',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        getFile(c, { path: args.path! }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // download_file
  // ---------------------------------------------------------------------
  server.registerTool(
    'download_file',
    {
      description: 'Get a download URL for a file (valid for short period).',
      inputSchema: z.object({
        path: z.string().optional().describe('File path or item ID'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.path) {
        return errorResponse({
          error:
            'Missing required parameter: "path" (file to download). Example: { "path": "/Documents/report.pdf" }. Returns a temporary download URL.',
          action_required: 'Provide the file path or item ID.',
          next_step: 'list_files',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        downloadFile(c, { path: args.path! }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // search_files
  // ---------------------------------------------------------------------
  server.registerTool(
    'search_files',
    {
      description: 'Search for files in OneDrive by name or content.',
      inputSchema: z.object({
        query: z.string().optional().describe('Search query'),
        top: z.number().optional().describe('Max results (default: 25)'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.query) {
        return errorResponse({
          error:
            'Missing required parameter: "query" (search text). Example: { "query": "quarterly report", "top": 20 }',
          action_required: 'Provide a non-empty query string.',
          next_step: 'search_files',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        searchFiles(c, { query: args.query!, top: args.top }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // upload_file
  // ---------------------------------------------------------------------
  server.registerTool(
    'upload_file',
    {
      description: 'Upload a file to OneDrive (text content only, max 4MB).',
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe('Destination path including filename (e.g., "/Documents/note.txt")'),
        content: z.string().optional().describe('File content (text)'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.path || !args.content) {
        return errorResponse({
          error:
            'Missing required parameters: "path" (destination path) and "content" (file content). Example: { "path": "/Documents/notes.txt", "content": "File content here..." }',
          action_required: 'Provide both path and content fields.',
          next_step: 'upload_file',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        uploadFile(c, { path: args.path!, content: args.content! }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // create_folder
  // ---------------------------------------------------------------------
  server.registerTool(
    'create_folder',
    {
      description: 'Create a new folder in OneDrive.',
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe('Full path for new folder (e.g., "/Documents/NewFolder")'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.path) {
        return errorResponse({
          error:
            'Missing required parameter: "path" (folder path to create). Example: { "path": "/Documents/ProjectFiles" }',
          action_required: 'Provide the new folder path.',
          next_step: 'create_folder',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        createFolder(c, { path: args.path! }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // delete_file
  // ---------------------------------------------------------------------
  server.registerTool(
    'delete_file',
    {
      description: 'Delete a file or folder from OneDrive.',
      inputSchema: z.object({
        path: z.string().optional().describe('File/folder path or item ID'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.path) {
        return errorResponse({
          error:
            'Missing required parameter: "path" (file/folder to delete). Example: { "path": "/Documents/old-file.txt" }. WARNING: This permanently deletes the item.',
          action_required: 'Provide the path or item ID to delete.',
          next_step: 'list_files',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        deleteFile(c, { path: args.path! }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // move_file
  // ---------------------------------------------------------------------
  server.registerTool(
    'move_file',
    {
      description: 'Move a file or folder to a new location.',
      inputSchema: z.object({
        sourcePath: z.string().optional().describe('Current file/folder path or ID'),
        destinationPath: z.string().optional().describe('New parent folder path'),
        newName: z.string().optional().describe('Optional new name'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.sourcePath || !args.destinationPath) {
        return errorResponse({
          error:
            'Missing required parameters: "sourcePath" and "destinationPath". Example: { "sourcePath": "/Documents/file.txt", "destinationPath": "/Archive", "newName": "archived-file.txt" }',
          action_required: 'Provide both sourcePath and destinationPath.',
          next_step: 'move_file',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        moveFile(
          c,
          {
            sourcePath: args.sourcePath!,
            destinationPath: args.destinationPath!,
            newName: args.newName,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // copy_file
  // ---------------------------------------------------------------------
  server.registerTool(
    'copy_file',
    {
      description: 'Copy a file or folder to a new location.',
      inputSchema: z.object({
        sourcePath: z.string().optional().describe('Current file/folder path or ID'),
        destinationPath: z.string().optional().describe('Destination folder path'),
        newName: z.string().optional().describe('Optional new name'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.sourcePath || !args.destinationPath) {
        return errorResponse({
          error:
            'Missing required parameters: "sourcePath" and "destinationPath". Example: { "sourcePath": "/Documents/template.docx", "destinationPath": "/Projects", "newName": "project-doc.docx" }',
          action_required: 'Provide both sourcePath and destinationPath.',
          next_step: 'copy_file',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        copyFile(
          c,
          {
            sourcePath: args.sourcePath!,
            destinationPath: args.destinationPath!,
            newName: args.newName,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // get_recent
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_recent',
    {
      description: 'Get recently accessed files.',
      inputSchema: z.object({
        top: z.number().optional().describe('Max items (default: 25)'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      const result = await callGraph(extra, (c, signal) =>
        getRecent(c, { top: args.top }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // get_shared
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_shared',
    {
      description: 'Get files shared with you by others.',
      inputSchema: z.object({
        top: z.number().optional().describe('Max items (default: 25)'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      const result = await callGraph(extra, (c, signal) =>
        getShared(c, { top: args.top }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // share_file
  // ---------------------------------------------------------------------
  server.registerTool(
    'share_file',
    {
      description: 'Create a sharing link for a file or folder.',
      inputSchema: z.object({
        path: z.string().optional().describe('File/folder path or ID'),
        type: LinkTypeEnum.optional().describe('Link type (default: view)'),
        scope: LinkScopeEnum.optional().describe(
          'Who can access (default: organization)',
        ),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.path) {
        return errorResponse({
          error:
            'Missing required parameter: "path" (file/folder to share). Example: { "path": "/Documents/report.pdf", "type": "view", "scope": "organization" }',
          action_required: 'Provide the file path or item ID to share.',
          next_step: 'share_file',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        shareFile(c, { path: args.path!, type: args.type, scope: args.scope }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // read_text_file
  // ---------------------------------------------------------------------
  server.registerTool(
    'read_text_file',
    {
      description: 'Read the contents of a text file directly.',
      inputSchema: z.object({
        path: z.string().optional().describe('File path or ID'),
        maxSize: z
          .number()
          .optional()
          .describe('Max bytes to read (default: 100KB)'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.path) {
        return errorResponse({
          error:
            'Missing required parameter: "path" (text file to read). Example: { "path": "/Documents/notes.txt", "maxSize": 102400 }. Only works with text files (txt, md, json, etc.).',
          action_required: 'Provide the file path or item ID to read.',
          next_step: 'list_files',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        readTextFile(c, { path: args.path!, maxSize: args.maxSize }, signal),
      );
      return successJson(result);
    }),
  );
}
