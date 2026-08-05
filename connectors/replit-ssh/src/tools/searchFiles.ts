import * as posixPath from 'path/posix';
import { z } from 'zod';

import type { SshConnectionError } from '../errors.js';
import { translateSftpError, translateSshError } from '../errors.js';
import {
  getConnection,
  isBinaryContent,
  logOperation,
  preflightChecks,
  SSH_CONNECT_TIMEOUT_MS,
  sftpOpWithSignal,
  validatePath,
} from '../ssh.js';
import { buildTimeoutError, composeRequestSignal } from '../timeouts.js';
import { wrapUntrusted } from '../untrusted-content.js';
import type { SFTPWrapper } from 'ssh2';

const MAX_RESULTS_DEFAULT = 50;
const MAX_RESULTS_LIMIT = 200;
const MAX_DEPTH_DEFAULT = 4;
const MAX_DEPTH_LIMIT = 10;
// Files larger than this are skipped for content search (still name-matched).
const MAX_GREP_FILE_BYTES = 1024 * 1024;
// Bounds total SFTP work so a huge project tree cannot run away.
const MAX_VISITED_ENTRIES = 10_000;
const MAX_LINE_LENGTH = 200;
// Per-file cap on returned matching lines so one hot file (e.g. a needle on
// every line of a 1 MB file) cannot flood the response; overflow is flagged
// via lineMatchesTruncated rather than silently dropped.
const MAX_LINE_MATCHES_PER_FILE = 5;

// At-least-one-of name_contains/content_contains is enforced at runtime inside
// the tool — a .refine() here would wrap the object in ZodEffects and break the
// `.shape` export the server registration relies on.
export const searchFilesSchema = z
  .object({
    host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
    user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
    path: z.string().optional().describe('Directory path to search under, relative to project root (default: ".")'),
    name_contains: z
      .string()
      .optional()
      .describe('Case-insensitive substring matched against file and directory names. At least one of "name_contains" or "content_contains" is required.'),
    content_contains: z
      .string()
      .optional()
      .describe('Case-insensitive substring matched against text file contents. Binary files and files over 1 MB are skipped. At least one of "name_contains" or "content_contains" is required.'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS_LIMIT)
      .optional()
      .describe(`Maximum number of matching entries to return (default ${MAX_RESULTS_DEFAULT}, max ${MAX_RESULTS_LIMIT}).`),
    max_depth: z
      .number()
      .int()
      .min(0)
      .max(MAX_DEPTH_LIMIT)
      .optional()
      .describe(`How many directory levels below "path" to descend (default ${MAX_DEPTH_DEFAULT}, max ${MAX_DEPTH_LIMIT}).`),
  });

export type SearchFilesArgs = z.infer<typeof searchFilesSchema>;

interface LineMatch {
  lineNumber: number;
  line: string | undefined;
}

interface SearchMatch {
  path: string | undefined;
  lineMatches?: LineMatch[];
  lineMatchesTruncated?: boolean;
}

interface WalkContext {
  sftp: SFTPWrapper;
  signal: AbortSignal;
  nameNeedle: string | null;
  contentNeedle: string | null;
  maxResults: number;
  maxDepth: number;
  source: string;
  matches: SearchMatch[];
  visited: number;
  filesSearched: number;
  truncated: boolean;
}

async function walkDirectory(ctx: WalkContext, absDir: string, relDir: string, depth: number): Promise<void> {
  if (ctx.matches.length >= ctx.maxResults || ctx.visited >= MAX_VISITED_ENTRIES) {
    ctx.truncated = true;
    return;
  }

  const entries = await sftpOpWithSignal<
    Array<{ filename: string; attrs: { isDirectory(): boolean; isSymbolicLink(): boolean; size: number } }>
  >(ctx.signal, SSH_CONNECT_TIMEOUT_MS, (cb) => {
    ctx.sftp.readdir(absDir, (err: Error | undefined, list) => {
      if (err) {
        cb(err);
        return;
      }
      cb(null, list.filter((entry) => entry.filename !== '.' && entry.filename !== '..'));
    });
  });

  for (const entry of entries) {
    if (ctx.matches.length >= ctx.maxResults || ctx.visited >= MAX_VISITED_ENTRIES) {
      ctx.truncated = true;
      return;
    }
    ctx.visited += 1;

    // Skip symlinks: following them risks cycles outside the SFTP root view.
    if (entry.attrs.isSymbolicLink()) continue;

    const relPath = relDir === '' ? entry.filename : `${relDir}/${entry.filename}`;

    if (entry.attrs.isDirectory()) {
      if (ctx.nameNeedle && entry.filename.toLowerCase().includes(ctx.nameNeedle)) {
        ctx.matches.push({ path: wrapUntrusted(relPath, ctx.source) });
      }
      if (depth < ctx.maxDepth) {
        await walkDirectory(ctx, posixPath.join(absDir, entry.filename), relPath, depth + 1);
      }
      continue;
    }

    const nameHit = ctx.nameNeedle !== null && entry.filename.toLowerCase().includes(ctx.nameNeedle);
    let lineMatches: LineMatch[] | undefined;
    let lineMatchesTruncated = false;

    if (ctx.contentNeedle && entry.attrs.size <= MAX_GREP_FILE_BYTES) {
      const content = await sftpOpWithSignal<Buffer>(ctx.signal, SSH_CONNECT_TIMEOUT_MS, (cb) => {
        ctx.sftp.readFile(posixPath.join(absDir, entry.filename), (err: Error | undefined, data: Buffer) => {
          if (err) {
            cb(err);
            return;
          }
          cb(null, data);
        });
      });
      ctx.filesSearched += 1;

      if (!isBinaryContent(content)) {
        const needle = ctx.contentNeedle;
        const lines = content.toString('utf-8').split('\n');
        const hits: LineMatch[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            if (hits.length >= MAX_LINE_MATCHES_PER_FILE) {
              lineMatchesTruncated = true;
              break;
            }
            hits.push({
              lineNumber: i + 1,
              line: wrapUntrusted(lines[i].slice(0, MAX_LINE_LENGTH), ctx.source),
            });
          }
        }
        if (hits.length > 0) lineMatches = hits;
      }
    }

    if (nameHit || lineMatches) {
      ctx.matches.push({
        path: wrapUntrusted(relPath, ctx.source),
        ...(lineMatches ? { lineMatches } : {}),
        ...(lineMatchesTruncated ? { lineMatchesTruncated } : {}),
      });
    }
  }
}

export async function replitSearchFiles(
  args: SearchFilesArgs,
  callerSignal?: AbortSignal,
): Promise<string> {
  const rawPath = args.path?.trim() || '.';

  let basePath = '.';
  if (rawPath !== '.') {
    const pathResult = validatePath(rawPath);
    if ('ok' in pathResult) return JSON.stringify(pathResult);
    basePath = pathResult.path;
  }

  const nameNeedle = args.name_contains?.trim().toLowerCase() || null;
  const contentNeedle = args.content_contains?.trim().toLowerCase() || null;
  if (!nameNeedle && !contentNeedle) {
    return JSON.stringify({
      ok: false,
      error: 'At least one of "name_contains" or "content_contains" is required.',
      code: 'PATH_INVALID',
      action_required: 'Provide a name and/or content substring to search for.',
      next_step: 'Retry `replit_search_files` with "name_contains" (file names) and/or "content_contains" (file contents).',
    });
  }

  const checks = preflightChecks(args.host, args.user);
  if ('error' in checks) return checks.error;
  const { key, host, user } = checks;

  const startTime = Date.now();
  const signal = composeRequestSignal(callerSignal);
  try {
    const { sftp } = await getConnection(host, user, key);

    const ctx: WalkContext = {
      sftp,
      signal,
      nameNeedle,
      contentNeedle,
      maxResults: args.max_results ?? MAX_RESULTS_DEFAULT,
      maxDepth: args.max_depth ?? MAX_DEPTH_DEFAULT,
      source: `replit-ssh:search-files:${basePath}`,
      matches: [],
      visited: 0,
      filesSearched: 0,
      truncated: false,
    };

    await walkDirectory(ctx, basePath, basePath === '.' ? '' : basePath, 0);

    logOperation('replit_search_files', host, basePath, 'ok', Date.now() - startTime);
    return JSON.stringify({
      ok: true,
      path: basePath,
      matches: ctx.matches,
      truncated: ctx.truncated,
      filesSearched: ctx.filesSearched,
    });
  } catch (err: unknown) {
    logOperation('replit_search_files', host, basePath, 'error', Date.now() - startTime);
    if (signal.aborted) return JSON.stringify(buildTimeoutError());
    const sshErr = err as Error & { code?: number | string; level?: string };
    if (sshErr.level) {
      const connErr = sshErr as SshConnectionError;
      return JSON.stringify(translateSshError(connErr, { proxyReachable: connErr.proxyReachable, handshakeCompleted: connErr.handshakeCompleted }));
    }
    return JSON.stringify(translateSftpError(sshErr, 'search', basePath));
  }
}
