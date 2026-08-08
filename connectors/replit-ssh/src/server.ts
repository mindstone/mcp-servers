import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { checkConnectionSchema, replitCheckConnection } from './tools/checkConnection.js';
import { deleteFileSchema, replitDeleteFile } from './tools/deleteFile.js';
import { listFilesSchema, replitListFiles } from './tools/listFiles.js';
import { moveFileSchema, replitMoveFile } from './tools/moveFile.js';
import { readFileSchema, replitReadFile } from './tools/readFile.js';
import { searchFilesSchema, replitSearchFiles } from './tools/searchFiles.js';
import { setupSshSchema, replitSetupSsh } from './tools/setupSsh.js';
import { statFileSchema, replitStatFile } from './tools/statFile.js';
import { writeFileSchema, replitWriteFile } from './tools/writeFile.js';

const SERVER_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const remoteReadAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const remoteWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

// replit_move fails a repeat call with DESTINATION_EXISTS rather than
// no-oping, so it must not advertise idempotence.
const remoteMoveAnnotations = {
  ...remoteWriteAnnotations,
  idempotentHint: false,
};

const localWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const textResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
});

export function createServer(): McpServer {
  const server = new McpServer({ name: 'mcp-server-replit-ssh', version: SERVER_VERSION });

  server.registerTool(
    'replit_check_connection',
    {
      title: 'Check Replit SSH Connection',
      description:
        'Check SSH connectivity to a Replit project. Verifies the connection works and reports the working directory, SFTP support, and server information. Use this to validate setup before file operations. Set verbose=true for detailed diagnostics when troubleshooting auth or connection failures.',
      annotations: remoteReadAnnotations,
      inputSchema: checkConnectionSchema.shape,
    },
    async (input, extra) => textResult(await replitCheckConnection(input, extra?.signal)),
  );

  server.registerTool(
    'replit_list_files',
    {
      title: 'List Replit Files',
      description:
        'List files and directories in a Replit project path. Returns file names, sizes, and types (file/directory). Use "." for root or specify a subdirectory path.',
      annotations: remoteReadAnnotations,
      inputSchema: listFilesSchema.shape,
    },
    async (input, extra) => textResult(await replitListFiles(input, extra?.signal)),
  );

  server.registerTool(
    'replit_read_file',
    {
      title: 'Read Replit File',
      description:
        'Read the contents of a file from a Replit project. Returns the file content as text. For binary files, returns base64-encoded content.',
      annotations: remoteReadAnnotations,
      inputSchema: readFileSchema.shape,
    },
    async (input, extra) => textResult(await replitReadFile(input, extra?.signal)),
  );

  server.registerTool(
    'replit_search_files',
    {
      title: 'Search Replit Files',
      description:
        'Search a Replit project for files by name substring and/or text content substring (case-insensitive). Recursive from the given path with result caps; returns matching paths and, for content matches, the matching lines. Use this to find where a name, key, or string is used without reading every file.',
      annotations: remoteReadAnnotations,
      inputSchema: searchFilesSchema.shape,
    },
    async (input, extra) => textResult(await replitSearchFiles(input, extra?.signal)),
  );

  server.registerTool(
    'replit_stat',
    {
      title: 'Stat Replit File',
      description:
        'Get metadata for a file or directory in a Replit project without reading its contents: type, size, permissions, and modification/access times.',
      annotations: remoteReadAnnotations,
      inputSchema: statFileSchema.shape,
    },
    async (input, extra) => textResult(await replitStatFile(input, extra?.signal)),
  );

  server.registerTool(
    'replit_write_file',
    {
      title: 'Write Replit File',
      description:
        'Write content to a file in a Replit project. Creates parent directories if needed. Uses atomic write (temp file + rename) and verifies the write by reading back. For binary files (images, etc.), pass base64-encoded content with encoding "base64".',
      annotations: remoteWriteAnnotations,
      inputSchema: writeFileSchema.shape,
    },
    async (input, extra) => textResult(await replitWriteFile(input, extra?.signal)),
  );

  server.registerTool(
    'replit_move',
    {
      title: 'Move Replit File',
      description:
        'Move or rename a file or directory within a Replit project. Never overwrites: fails if the destination already exists. The destination parent directory must already exist.',
      annotations: remoteMoveAnnotations,
      inputSchema: moveFileSchema.shape,
    },
    async (input, extra) => textResult(await replitMoveFile(input, extra?.signal)),
  );

  server.registerTool(
    'replit_delete_file',
    {
      title: 'Delete Replit File',
      description:
        'Permanently delete a file from a Replit project (files only, not directories). Deletion is irreversible — there is no trash. Enabled by default; approval gating is the responsibility of the host tool-approval layer.',
      annotations: remoteWriteAnnotations,
      inputSchema: deleteFileSchema.shape,
    },
    async (input, extra) => textResult(await replitDeleteFile(input, extra?.signal)),
  );

  server.registerTool(
    'replit_setup_ssh',
    {
      title: 'Set Up Replit SSH',
      description:
        'Set up SSH keys and configuration for connecting to Replit projects. Generates an Ed25519 key pair, configures ~/.ssh/config, and provides the public key for the user to add to their Replit account. Safe to run multiple times — skips steps already completed.',
      annotations: localWriteAnnotations,
      inputSchema: setupSshSchema.shape,
    },
    async (input) => textResult(await replitSetupSsh(input)),
  );

  return server;
}
