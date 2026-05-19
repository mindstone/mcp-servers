import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { checkConnectionSchema, replitCheckConnection } from './tools/checkConnection.js';
import { listFilesSchema, replitListFiles } from './tools/listFiles.js';
import { readFileSchema, replitReadFile } from './tools/readFile.js';
import { setupSshSchema, replitSetupSsh } from './tools/setupSsh.js';
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
