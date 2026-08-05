import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, hasApiKey } from '../auth.js';
import { downloadFile, getVisualStatus, validateDownloadUrl } from '../client.js';
import { NapkinError, FORMAT_EXTENSIONS } from '../types.js';
import { withErrorHandling } from '../utils.js';

function requireApiKey(): string {
  if (!hasApiKey()) {
    throw new NapkinError(
      'Napkin API key not configured',
      'AUTH_REQUIRED',
      'The user adds the Napkin API key in Settings → Connectors in the app. Do not ask for it in chat. Get it from https://app.napkin.ai → Account Settings → Developers.',
    );
  }
  return getApiKey();
}

/**
 * Slugify a filename string.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
}

const WORKSPACE_OUTPUT_SUBDIRS = ['Chief-of-Staff', 'generated-visuals'] as const;
const HOME_OUTPUT_SUBDIRS = ['Pictures', 'NapkinVisuals'] as const;

/**
 * Resolve the requested (lexical) output directory for downloaded visuals.
 *
 * - With MCP_WORKSPACE_PATH: saves to workspace/Chief-of-Staff/generated-visuals/
 * - Without: saves to ~/Pictures/NapkinVisuals/
 *
 * This is the *requested* path only — callers must go through
 * prepareOutputDir() (canonicalisation + containment) before writing.
 */
export function resolveOutputDir(): string {
  const workspacePath = process.env.MCP_WORKSPACE_PATH;
  if (workspacePath) {
    return path.join(workspacePath, ...WORKSPACE_OUTPUT_SUBDIRS);
  }
  return path.join(os.homedir(), ...HOME_OUTPUT_SUBDIRS);
}

/**
 * Canonicalise the download output directory and verify canonical-prefix
 * containment beneath its root (security invariant #5 — the same
 * canonical-prefix discipline applies to download targets).
 *
 * The root (MCP_WORKSPACE_PATH, or the home directory fallback) is canonical
 * (symlinks resolved — a symlinked workspace root is fine), then the fixed
 * subdirectories are created and canonicalised, and the result must stay
 * beneath the canonical root. A pre-planted symlink at `Chief-of-Staff` or
 * `generated-visuals` pointing outside the root fails closed with an
 * observable OUTPUT_PATH_REJECTED error instead of silently redirecting the
 * write.
 */
function prepareOutputDir(): string {
  const workspacePath = process.env.MCP_WORKSPACE_PATH;
  const root = workspacePath || os.homedir();
  const subdirs = workspacePath ? WORKSPACE_OUTPUT_SUBDIRS : HOME_OUTPUT_SUBDIRS;

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch {
    throw new NapkinError(
      'Download output root is not accessible',
      'OUTPUT_ROOT_UNAVAILABLE',
      workspacePath
        ? 'Check that MCP_WORKSPACE_PATH exists and is accessible.'
        : 'Check that your home directory exists and is accessible, or set MCP_WORKSPACE_PATH.',
    );
  }

  const requested = path.join(canonicalRoot, ...subdirs);

  // Canonicalise the deepest existing ancestor and verify containment BEFORE
  // creating anything — mkdir through a planted symlink would otherwise
  // create directories outside the root.
  let ancestor = requested;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonicalAncestor = fs.realpathSync(ancestor);
  const ancestorRelative = path.relative(canonicalRoot, canonicalAncestor);
  if (ancestorRelative !== '' && (ancestorRelative.startsWith('..') || path.isAbsolute(ancestorRelative))) {
    throw new NapkinError(
      'Refusing download target outside the output root',
      'OUTPUT_PATH_REJECTED',
      'A component of the download directory is a symlink pointing outside the workspace. Remove it and try again.',
    );
  }

  fs.mkdirSync(requested, { recursive: true });
  const canonicalDir = fs.realpathSync(requested);

  const relative = path.relative(canonicalRoot, canonicalDir);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new NapkinError(
      'Refusing download target outside the output root',
      'OUTPUT_PATH_REJECTED',
      'A component of the download directory is a symlink pointing outside the workspace. Remove it and try again.',
    );
  }

  return canonicalDir;
}

/**
 * Write the downloaded bytes into `outputDir` under `baseName`, returning the
 * final path. Never overwrites and never follows a pre-planted symlink.
 *
 * The write goes to a fresh, unpredictable staging directory created
 * atomically with `fs.mkdtempSync` (mode 0700) directly inside the verified
 * output directory — only the sanitised basename is carried over, so no
 * check-then-use swap of any path component can redirect the write. The file
 * is opened O_CREAT|O_EXCL|O_WRONLY (mode 0600), fstat-checked to be a
 * regular file, and written through the single fd.
 *
 * The finished file is then hard-linked into place: linkSync fails with
 * EEXIST when the destination name is taken — by a real file OR a symlink —
 * so existing content is never overwritten and a planted symlink is never
 * followed. The staging directory is a child of `outputDir`, so the link is
 * always same-filesystem; filesystems without hard-link support fall back to
 * an exclusive create at the destination (same no-overwrite semantics).
 */
function writeDownloadExclusive(outputDir: string, baseName: string, data: Buffer): string {
  const stagingDir = fs.mkdtempSync(path.join(outputDir, '.napkin-staging-'));
  try {
    const stagingFile = path.join(stagingDir, baseName);
    const fd = fs.openSync(stagingFile, 'wx', 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) {
        throw new NapkinError(
          'Download staging path is not a regular file',
          'OUTPUT_PATH_REJECTED',
          'Try the download again.',
        );
      }
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }

    const finalPath = path.join(outputDir, baseName);
    try {
      fs.linkSync(stagingFile, finalPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw fileExistsError(baseName);
      // No hard-link support (rare): exclusive-create at the destination.
      let destFd: number;
      try {
        destFd = fs.openSync(finalPath, 'wx', 0o600);
      } catch (openError) {
        if ((openError as NodeJS.ErrnoException).code === 'EEXIST') throw fileExistsError(baseName);
        throw openError;
      }
      try {
        fs.writeFileSync(destFd, data);
      } finally {
        fs.closeSync(destFd);
      }
    }
    return finalPath;
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

function fileExistsError(baseName: string): NapkinError {
  return new NapkinError(
    `A file named '${baseName}' already exists in the download directory`,
    'FILE_EXISTS',
    'Existing files are never overwritten. Pass a different filename, or omit filename to auto-generate one.',
  );
}

export function registerDownloadTools(server: McpServer): void {
  server.registerTool(
    'napkin_download_visual',
    {
      description:
        'Download a generated Napkin visual file to disk. ' +
        'Use this after napkin_check_status returns "completed" to save files locally. ' +
        'Pass a file URL from the generated_files array in the status response. ' +
        'Files are saved to your private space (Chief-of-Staff/generated-visuals/) in the workspace, or ~/Pictures/NapkinVisuals/ if no workspace is set. ' +
        'Existing files are never overwritten — if the name is taken, pass a different filename or omit it to auto-generate one. ' +
        'IMPORTANT: Download URLs expire 30 minutes after generation. ' +
        'SECURITY: file_url must be a Napkin-hosted https URL (host on the hard-coded allow-list, currently api.napkin.ai); ' +
        'requests to other hosts are refused without sending the request, to prevent leaking the Napkin API key. ' +
        'URLs with userinfo (user:pass@host) and non-HTTPS schemes are also refused.',
      inputSchema: z.object({
        file_url: z
          .string()
          .min(1)
          .describe('The download URL from generated_files[].url in the status response'),
        filename: z
          .string()
          .optional()
          .describe('Optional base filename (without extension). If omitted, auto-generated from timestamp.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const { file_url, filename } = args;

      // SECURITY: validate the URL BEFORE any outbound network call. Without
      // this hoist, the format-detection else-branch below would invoke
      // `getVisualStatus(apiKey, requestId)` (which sends
      // `Authorization: Bearer ${NAPKIN_API_KEY}` to api.napkin.ai) for any
      // `file_url` whose pathname embeds `/visual/<id>/`, even when the URL's
      // host/scheme/userinfo would later be rejected by `downloadFile`. By
      // validating first we guarantee that a rejected `file_url` produces a
      // structured `URL_REJECTED` error with ZERO outbound `fetch` calls
      // anywhere in the handler. Re-using the parsed URL avoids a second
      // `new URL()` parse below.
      const validatedUrl = validateDownloadUrl(file_url);

      // Detect file extension from URL or by querying status
      const formatMatch = file_url.match(/\.(svg|png|pptx?)$/i);
      let extension = '.svg';
      if (formatMatch) {
        extension = formatMatch[0].toLowerCase();
        // Normalize .ppt to .pptx
        if (extension === '.ppt') extension = '.pptx';
      } else {
        // Try to determine format from the (already-validated) URL structure
        try {
          const pathParts = validatedUrl.pathname.split('/');
          const requestIdIndex = pathParts.indexOf('visual');
          if (requestIdIndex >= 0) {
            const requestId = pathParts[requestIdIndex + 1];
            if (requestId) {
              const statusResp = await getVisualStatus(apiKey, requestId);
              const format = statusResp.request?.format as string;
              if (format && FORMAT_EXTENSIONS[format]) {
                extension = FORMAT_EXTENSIONS[format];
              }
            }
          }
        } catch (formatError) {
          // Best-effort pre-check; a failure must be observable, never
          // silent. Falls through to the default .svg extension.
          console.error(
            '[Napkin] Format detection via status endpoint failed; defaulting to .svg:',
            formatError instanceof Error ? formatError.message : formatError,
          );
        }
      }

      const data = await downloadFile(apiKey, validatedUrl.toString());

      const outputDir = prepareOutputDir();

      // Slugify strips everything outside [a-z0-9-]; a filename that reduces
      // to nothing falls back to a timestamped name so the basename can
      // never be empty or dotfile-like.
      const slug = (filename ? slugify(filename) : '') || `napkin-${Date.now()}`;
      const outputPath = writeDownloadExclusive(outputDir, `${slug}${extension}`, data);

      return JSON.stringify(
        {
          success: true,
          file_path: outputPath,
          size_bytes: data.length,
          message: `Visual saved to: ${outputPath}`,
        },
        null,
        2,
      );
    }),
  );
}
