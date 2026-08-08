#!/usr/bin/env node
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { logger, redactSensitiveInLogs } from './logger.js';
import { wrapUntrusted } from './untrusted-content.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

export const SERVER_VERSION = packageJson.version;
export const DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS = 180_000;
// Matches the documented ceiling in server.json / README (max 30 minutes).
export const MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS = 1_800_000;
export const NOT_CONFIGURED_RESOLUTION =
  "Set OPENAI_API_KEY in your MCP host's settings.";
const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_IMAGES = 5;
const MIN_BASE64_IMAGE_LENGTH = 100;
// Legacy directory name from a prior bundled host build; preserved verbatim
// only so existing user folders are detected and migrated to the host-neutral
// modern directory on first run. New installations never create this path.
const LEGACY_FALLBACK_DIR_NAME = 'RebelImages';
const MODERN_FALLBACK_DIR_NAME = 'MCP-Generated-Images';
export const LEGACY_FALLBACK_FOLDER_NAME = LEGACY_FALLBACK_DIR_NAME;
export const MODERN_FALLBACK_FOLDER_NAME = MODERN_FALLBACK_DIR_NAME;
const OPENAI_API_BASE_URL = 'https://api.openai.com';
const KNOWN_MODELS = new Set([
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
]);

const SIZE_MAP: Record<string, string> = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
};

export type ToolErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_API_KEY'
  | 'RATE_LIMITED'
  | 'CONTENT_POLICY'
  | 'WORKSPACE_FENCE_VIOLATION'
  | 'MODEL_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'WRITE_FAILED'
  | 'INVALID_INPUT'
  | 'INVALID_IMAGE_DATA';

const OUTPUT_FORMAT_EXTENSIONS: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

const OUTPUT_FORMAT_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

interface ToolErrorPayload {
  ok: false;
  error: string;
  code: ToolErrorCode;
  resolution: string;
}

interface OpenAIErrorData {
  error?: {
    message?: string;
  };
}

// External responses are validated with Zod (repo convention) rather than
// cast: a malformed success body fails closed with an observable NETWORK_ERROR
// instead of flowing unknown shapes into the image-mapping code.
const openAIImageResponseSchema = z
  .object({
    data: z
      .array(z.object({ b64_json: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

type OpenAIImageResponse = z.infer<typeof openAIImageResponseSchema>;

interface LoadedLocalImage {
  path: string;
  filename: string;
  mime: string;
  data: Buffer;
}

interface ToolCallbackContext {
  signal?: AbortSignal;
}

export class OpenAIImageToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'OpenAIImageToolError';
  }
}

class WorkspaceFenceToolError extends OpenAIImageToolError {
  constructor(message: string, resolution: string) {
    super('WORKSPACE_FENCE_VIOLATION', message, resolution);
    this.name = 'WorkspaceFenceToolError';
  }
}

const modelSupportsModeration = (model: string): boolean =>
  model.startsWith('gpt-image-2');

// `moderation` is a plain tool input like any other: both 'auto' (the
// default) and 'low' are forwarded upstream when the model supports it.
// Invocation gating is the host's tool-approval layer's job, not this
// connector's.
const resolveModeration = (
  requested: 'auto' | 'low' | undefined,
): 'auto' | 'low' => requested ?? 'auto';

// gpt-image-2 rejects background: 'transparent' upstream (OpenAI Images API,
// verified 2026-08). Unknown models (OPENAI_IMAGE_MODEL overrides) pass
// through to upstream validation, matching the configuredModel() philosophy.
const modelKnownToRejectTransparency = (model: string): boolean =>
  model.startsWith('gpt-image-2');

export const configuredModel = (): string =>
  process.env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-2';

export const configuredWorkspacePath = (): string | undefined =>
  process.env.MCP_WORKSPACE_PATH?.trim() || undefined;

const parseAllowedSymlinkRoots = (rawValue: string): string[] => {
  if (!rawValue) {
    return [];
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rawValue);
  } catch {
    logger.warn(
      '[openai-image] Invalid MCP_ALLOWED_SYMLINK_ROOTS; using workspace-only mode.',
      { reason: 'invalid-json' },
    );
    return [];
  }

  if (
    !Array.isArray(parsedValue) ||
    !parsedValue.every(
      (entry): entry is string =>
        typeof entry === 'string' &&
        entry.trim().length > 0 &&
        path.isAbsolute(entry),
    )
  ) {
    logger.warn(
      '[openai-image] Invalid MCP_ALLOWED_SYMLINK_ROOTS; using workspace-only mode.',
      { reason: 'expected-absolute-path-array' },
    );
    return [];
  }

  return parsedValue;
};

// The parsed roots are a module-load snapshot: the env is read once per spawn
// (parallel to WORKSPACE_PATH). Cache the parsed result keyed by the raw env
// string so repeated calls within a single process do not re-emit the
// malformed-env warning — the snapshot is stable for a given env value.
let allowedSymlinkRootsCache: { rawEnv: string; roots: string[] } | undefined;

export const configuredAllowedSymlinkRoots = (): string[] => {
  const rawEnv = process.env.MCP_ALLOWED_SYMLINK_ROOTS?.trim() ?? '';
  if (allowedSymlinkRootsCache && allowedSymlinkRootsCache.rawEnv === rawEnv) {
    return allowedSymlinkRootsCache.roots;
  }
  const roots = parseAllowedSymlinkRoots(rawEnv);
  allowedSymlinkRootsCache = { rawEnv, roots };
  return roots;
};

const WORKSPACE_PATH = configuredWorkspacePath();
const ALLOWED_SYMLINK_ROOTS = configuredAllowedSymlinkRoots();

export const configuredApiKey = (): string | undefined => {
  const raw = process.env.OPENAI_API_KEY;
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed || trimmed === '{{OPENAI_API_KEY}}') {
    return undefined;
  }

  return trimmed;
};

export const resolveRequestTimeoutMs = (): number => {
  const raw = process.env.OPENAI_IMAGE_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS;
  }

  // Strict whole-string integer parsing: parseInt would silently truncate
  // values like '1e9' or '180000abc'.
  const trimmed = raw.trim();
  const parsed = /^\d+$/u.test(trimmed)
    ? Number(trimmed)
    : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS
  ) {
    logger.warn(
      '[openai-image] Invalid OPENAI_IMAGE_REQUEST_TIMEOUT_MS; using default.',
      { rawValue: raw, fallbackMs: DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS },
    );
    return DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS;
  }

  return parsed;
};

export const OPENAI_IMAGE_REQUEST_TIMEOUT_MS = resolveRequestTimeoutMs();

if (!KNOWN_MODELS.has(configuredModel())) {
  logger.warn(
    '[openai-image] Unknown OPENAI_IMAGE_MODEL value. Continuing with upstream validation.',
    { model: configuredModel(), knownModels: [...KNOWN_MODELS] },
  );
}

// AGENTS.md security invariant #6: values a caller controls (tool arguments
// such as image_paths/mask_path, or env config such as OPENAI_IMAGE_MODEL) are
// enveloped before they are echoed into model-visible error text, so a crafted
// value carrying a close-tag variant cannot terminate the result envelope and
// be re-read as instructions. The raw text stays intact inside the envelope —
// fence errors deliberately keep the full supplied path so the caller can
// self-correct.
const envelopeEchoedValue = (value: string, source: string): string =>
  wrapUntrusted(value, source) ?? value;

const envelopeToolInput = (value: string): string =>
  envelopeEchoedValue(value, 'openai-image:tool-input');

const envelopeConfiguredModel = (value: string): string =>
  envelopeEchoedValue(value, 'openai-image:config:model');

// Splits on whole `<untrusted-content …>…</untrusted-content>` spans so the
// path-collapsing below never mangles an envelope's own close tag.
const UNTRUSTED_ENVELOPE_SPAN =
  /(<untrusted-content source="[^"]*">[\s\S]*?<\/untrusted-content>)/u;

const collapseAbsolutePaths = (text: string): string =>
  text.replace(
    /(?:[A-Za-z]:\\|\/)[^\s"'`]+/gu,
    (match) => path.basename(match.replace(/[\\/]+$/u, '')) || '<path>',
  );

const sanitizeUserFacingText = (value: string): string => {
  const redacted = redactSensitiveInLogs(value);
  const redactedText = typeof redacted === 'string' ? redacted : String(redacted);
  return redactedText
    .split(UNTRUSTED_ENVELOPE_SPAN)
    .map((segment, index) =>
      index % 2 === 1 ? segment : collapseAbsolutePaths(segment),
    )
    .join('');
};

const toErrorPayload = (error: unknown): ToolErrorPayload => {
  if (error instanceof WorkspaceFenceToolError) {
    return {
      ok: false,
      code: error.code,
      error: error.message,
      resolution: error.resolution,
    };
  }

  if (error instanceof OpenAIImageToolError) {
    return {
      ok: false,
      code: error.code,
      error: sanitizeUserFacingText(error.message),
      resolution: sanitizeUserFacingText(error.resolution),
    };
  }

  return {
    ok: false,
    code: 'NETWORK_ERROR',
    error: 'Network error while processing the image request.',
    resolution:
      'Check your network connection and try again. If this keeps happening, increase OPENAI_IMAGE_REQUEST_TIMEOUT_MS.',
  };
};

const toErrorToolResult = (payload: ToolErrorPayload): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  isError: true,
});

export const withErrorHandling = async (
  operation: () => Promise<CallToolResult>,
): Promise<CallToolResult> => {
  try {
    return await operation();
  } catch (error) {
    const payload = toErrorPayload(error);
    logger.error('[openai-image] Tool call failed.', { payload, error });
    return toErrorToolResult(payload);
  }
};

const ensureConfiguredApiKey = (): string => {
  const apiKey = configuredApiKey();
  if (!apiKey) {
    throw new OpenAIImageToolError(
      'NOT_CONFIGURED',
      'OpenAI API key is not configured.',
      NOT_CONFIGURED_RESOLUTION,
    );
  }
  return apiKey;
};

const getErrorCode = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'unknown error';
};

/**
 * Find Chief-of-Staff folder case-insensitively.
 * Returns the actual folder name found, or null if not found.
 */
const findChiefOfStaffFolder = (workspacePath: string): string | null => {
  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        entry.name.toLowerCase() === 'chief-of-staff'
      ) {
        return entry.name;
      }
    }
  } catch (error) {
    logger.error('[openai-image] Failed to read workspace directory.', { error });
  }
  return null;
};

const safeLstat = async (targetPath: string): Promise<fs.Stats | null> => {
  try {
    return await fs.promises.lstat(targetPath);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const copyDirectoryPreservingModes = async (
  sourceDir: string,
  targetDir: string,
): Promise<void> => {
  const sourceStats = await fs.promises.stat(sourceDir);
  const sourceMode = sourceStats.mode & 0o777;
  await fs.promises.mkdir(targetDir, {
    recursive: true,
    mode: sourceMode,
  });

  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryPreservingModes(sourcePath, targetPath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      const linkTarget = await fs.promises.readlink(sourcePath);
      await fs.promises.symlink(linkTarget, targetPath);
      continue;
    }

    const entryStats = await fs.promises.stat(sourcePath);
    await fs.promises.copyFile(
      sourcePath,
      targetPath,
      fs.constants.COPYFILE_EXCL,
    );
    await fs.promises.chmod(targetPath, entryStats.mode & 0o777);
  }

  await fs.promises.chmod(targetDir, sourceMode);
};

export const migrateLegacyFallbackDirectory = async (
  picturesDir: string = path.join(os.homedir(), 'Pictures'),
): Promise<string> => {
  const legacyDir = path.join(picturesDir, LEGACY_FALLBACK_DIR_NAME);
  const modernDir = path.join(picturesDir, MODERN_FALLBACK_DIR_NAME);

  const [legacyStats, modernStats] = await Promise.all([
    safeLstat(legacyDir),
    safeLstat(modernDir),
  ]);

  if (modernStats?.isSymbolicLink()) {
    // Target is a symlink — refuse to follow it. Writes redirected through a
    // symlink we did not create are out of scope; fall through to a sibling
    // directory so the user can investigate without us silently writing
    // through an unexpected indirection.
    const safeFallback = path.join(picturesDir, `${MODERN_FALLBACK_DIR_NAME}-safe`);
    logger.warn('[openai-image] Modern fallback directory is a symlink; using sibling safe directory instead.', {
      target: path.basename(modernDir),
      fallback: path.basename(safeFallback),
    });
    await fs.promises.mkdir(safeFallback, { recursive: true, mode: 0o700 });
    return safeFallback;
  }

  if (legacyStats?.isSymbolicLink()) {
    logger.info('[openai-image] Skipping legacy migration because source is a symlink.', {
      source: path.basename(legacyDir),
    });
    if (!modernStats) {
      await fs.promises.mkdir(modernDir, { recursive: true, mode: 0o700 });
    }
    return modernDir;
  }

  if (legacyStats?.isDirectory() && !modernStats) {
    try {
      await fs.promises.rename(legacyDir, modernDir);
      logger.info('[openai-image] Migrated legacy image folder.', {
        source: path.basename(legacyDir),
        target: path.basename(modernDir),
      });
      return modernDir;
    } catch (error) {
      const code = getErrorCode(error);
      if (code === 'EEXIST') {
        logger.info('[openai-image] Skipping legacy migration because target already exists.', {
          source: path.basename(legacyDir),
          target: path.basename(modernDir),
        });
        return modernDir;
      }

      if (code === 'EXDEV') {
        await copyDirectoryPreservingModes(legacyDir, modernDir);
        await fs.promises.rm(legacyDir, { recursive: true, force: false });
        logger.info('[openai-image] Migrated legacy image folder across filesystems.', {
          source: path.basename(legacyDir),
          target: path.basename(modernDir),
        });
        return modernDir;
      }

      throw error;
    }
  }

  if (legacyStats?.isDirectory() && modernStats?.isDirectory()) {
    logger.info('[openai-image] Legacy image folder detected; migration skipped because target exists.', {
      source: path.basename(legacyDir),
      target: path.basename(modernDir),
    });
  }

  if (!modernStats) {
    await fs.promises.mkdir(modernDir, { recursive: true, mode: 0o700 });
  }

  return modernDir;
};

let fallbackDirectoryPromise: Promise<string> | null = null;

export const resetFallbackDirectoryCacheForTests = (): void => {
  fallbackDirectoryPromise = null;
};

const getImageSaveDir = async (): Promise<string> => {
  const workspacePath = WORKSPACE_PATH;
  if (workspacePath) {
    const chiefOfStaff = findChiefOfStaffFolder(workspacePath);
    if (chiefOfStaff) {
      return path.join(workspacePath, chiefOfStaff, 'generated-images');
    }
    return path.join(workspacePath, 'Chief-of-Staff', 'generated-images');
  }

  if (!fallbackDirectoryPromise) {
    fallbackDirectoryPromise = migrateLegacyFallbackDirectory();
  }

  return fallbackDirectoryPromise;
};

export const generateFilename = (
  _prompt: string,
  index: number,
  count: number,
  extension: string = 'png',
): string => {
  const suffix = crypto.randomBytes(8).toString('hex');
  if (count > 1) {
    return `${Date.now()}-${index + 1}-${suffix}.${extension}`;
  }
  return `${Date.now()}-${suffix}.${extension}`;
};

export const validateBase64ImageData = (
  base64Value: string | undefined,
): Buffer => {
  if (!base64Value || base64Value.length < MIN_BASE64_IMAGE_LENGTH) {
    throw new OpenAIImageToolError(
      'INVALID_IMAGE_DATA',
      'Invalid image data returned by the upstream image API.',
      'Try the request again with a simpler prompt.',
    );
  }

  const buffer = Buffer.from(base64Value, 'base64');
  if (buffer.length === 0) {
    throw new OpenAIImageToolError(
      'INVALID_IMAGE_DATA',
      'Received empty image data from the upstream image API.',
      'Try the request again with a simpler prompt.',
    );
  }

  return buffer;
};

// Upstream image bytes must match the format the file extension and inline
// MIME type will claim — otherwise arbitrary bytes could be persisted as
// `.png`/`.jpg`/`.webp` and served to downstream consumers under a false type.
const IMAGE_FORMAT_SIGNATURES: Record<
  string,
  Array<{ offset: number; bytes: number[] }>
> = {
  png: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  jpg: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  webp: [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // 'WEBP'
  ],
};

const ensureBufferMatchesImageFormat = (
  buffer: Buffer,
  extension: string,
): void => {
  const signatures = IMAGE_FORMAT_SIGNATURES[extension];
  if (!signatures) {
    return;
  }

  const matches = signatures.every(({ offset, bytes }) =>
    bytes.every((byte, byteIndex) => buffer[offset + byteIndex] === byte),
  );
  if (!matches) {
    throw new OpenAIImageToolError(
      'INVALID_IMAGE_DATA',
      'Image data returned by the upstream image API does not match the requested format.',
      'Try the request again with a simpler prompt.',
    );
  }
};

export const saveImageToDisk = async (
  saveDir: string,
  prompt: string,
  b64: string,
  index: number,
  count: number,
  extension: string = 'png',
): Promise<string> => {
  await ensureOutputDirectoryIsAllowed(saveDir);
  await fs.promises.mkdir(saveDir, { recursive: true });
  const canonicalSaveDir = await canonicalizeAllowedOutputDirectory(saveDir);
  const buffer = validateBase64ImageData(b64);
  ensureBufferMatchesImageFormat(buffer, extension);

  // Write through the canonical directory, never the validated pathname
  // (write side of the MED-1 pattern): a local race could swap a component of
  // `saveDir` for a symlink between validation and the write, and a swap-back
  // before any post-open re-check would let bytes flow outside the fence
  // through the already-opened descriptor. The canonical path contains no
  // symlink components, so no swap can redirect it. The bytes are staged in a
  // fresh, unpredictable mkdtemp directory (0700) created atomically inside
  // the canonical directory, written through a single descriptor, then
  // hard-linked into place — link(2) fails with EEXIST when the destination
  // name is taken (by a real file OR a planted symlink), so existing content
  // is never overwritten. A mid-flight swap of a real ancestor directory
  // breaks the pathname (fails closed, observably) instead of redirecting it;
  // a directory whose canonical identity changed is rejected before any bytes
  // flow. Filesystems without hard-link support fall back to an exclusive
  // create at the destination (same no-overwrite semantics). The directory's
  // canonical identity is re-verified before any bytes flow: before the staging
  // write, immediately before and after the `link`, and around the
  // exclusive-create fallback (whose `open` would otherwise follow a swapped
  // symlink after the staging pathname breaks with ENOENT).
  const ensureDirectoryUnchanged = async (): Promise<void> => {
    const currentCanonicalDir = await fs.promises
      .realpath(canonicalSaveDir)
      .catch(() => null);
    if (currentCanonicalDir !== canonicalSaveDir) {
      throw new WorkspaceFenceToolError(
        'Generated image folder changed while the image was being saved.',
        'Check the output folder for symbolic links or other changes, then try again.',
      );
    }
  };

  const writeAttempt = async (): Promise<string> => {
    const filename = generateFilename(prompt, index, count, extension);
    let stagingDir: string;
    try {
      stagingDir = await fs.promises.mkdtemp(
        path.join(canonicalSaveDir, '.openai-image-staging-'),
      );
    } catch (stagingError) {
      // A mid-flight directory swap breaks the canonical pathname (ENOENT) —
      // surface the fence violation rather than a generic write failure.
      await ensureDirectoryUnchanged();
      throw stagingError;
    }
    try {
      const stagingFile = path.join(stagingDir, filename);
      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(stagingFile, 'wx', 0o600);
      } catch (openError) {
        await ensureDirectoryUnchanged();
        throw openError;
      }
      try {
        await ensureDirectoryUnchanged();
        await handle.writeFile(buffer);
        const stats = await handle.stat();
        if (stats.size === 0) {
          throw new OpenAIImageToolError(
            'WRITE_FAILED',
            'Generated image file was empty after write.',
            'Try the request again.',
          );
        }
      } finally {
        await handle.close().catch(() => undefined);
      }

      const finalPath = path.join(canonicalSaveDir, filename);
      try {
        // Re-verify immediately before the link and before the fallback open:
        // a swap after the staging write would otherwise break the staging
        // pathname (ENOENT) and redirect the fallback's exclusive-create write
        // through the swapped symlink, outside the fence.
        await ensureDirectoryUnchanged();
        await fs.promises.link(stagingFile, finalPath);
        await ensureDirectoryUnchanged();
      } catch (linkError) {
        if (
          linkError instanceof OpenAIImageToolError ||
          getErrorCode(linkError) === 'EEXIST'
        ) {
          throw linkError;
        }
        // No hard-link support (rare): exclusive-create at the destination.
        await ensureDirectoryUnchanged();
        const destHandle = await fs.promises.open(finalPath, 'wx', 0o600);
        try {
          await destHandle.writeFile(buffer);
        } finally {
          await destHandle.close().catch(() => undefined);
        }
        await ensureDirectoryUnchanged();
      }
      return path.join(saveDir, filename);
    } finally {
      await fs.promises
        .rm(stagingDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  };

  try {
    return await writeAttempt();
  } catch (firstError) {
    if (firstError instanceof OpenAIImageToolError) {
      throw firstError;
    }
    if (getErrorCode(firstError) !== 'EEXIST') {
      throw new OpenAIImageToolError(
        'WRITE_FAILED',
        'Failed to save generated image to disk.',
        'Check folder permissions and available disk space, then try again.',
      );
    }

    try {
      return await writeAttempt();
    } catch (secondError) {
      if (secondError instanceof OpenAIImageToolError) {
        throw secondError;
      }
      if (getErrorCode(secondError) === 'EEXIST') {
        throw new OpenAIImageToolError(
          'WRITE_FAILED',
          'Failed to save generated image because filenames collided.',
          'Try the request again.',
        );
      }
      throw new OpenAIImageToolError(
        'WRITE_FAILED',
        'Failed to save generated image to disk.',
        'Check folder permissions and available disk space, then try again.',
      );
    }
  }
};

const getWorkspacePathResolutionError = (
  workspacePath: string,
  error: unknown,
): string => {
  const code = getErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return `Can't access your workspace right now: ${workspacePath}. Check folder permissions and try again.`;
  }
  if (code === 'ENOENT') {
    return `Workspace path is unavailable: ${workspacePath}. Open or create a workspace first.`;
  }
  if (code === 'ELOOP') {
    return `Workspace path contains a symbolic link loop: ${workspacePath}. Choose a working workspace path and try again.`;
  }
  return `Failed to access workspace path: ${workspacePath} — ${getErrorMessage(error)}`;
};

const getLocalImageReadError = (
  imageLabel: string,
  inputPath: string,
  error: unknown,
): string => {
  const safeInputPath = envelopeToolInput(inputPath);
  const code = getErrorCode(error);
  if (code === 'ENOENT') {
    return `${imageLabel} not found: ${safeInputPath}`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `${imageLabel} permission denied: ${safeInputPath}`;
  }
  if (code === 'ELOOP') {
    return `${imageLabel} path contains a symbolic link loop: ${safeInputPath}`;
  }
  // Never append the raw OS error message: it embeds the caller-controlled
  // path again, un-enveloped, and path-collapsing can reassemble a close-tag
  // variant split across the final segment — a breakout channel. Node's
  // ErrnoException codes are safe uppercase identifiers.
  const codeSuffix = code ? ` (error ${code})` : '';
  return `Failed to read ${imageLabel.toLowerCase()}: ${safeInputPath}${codeSuffix}`;
};

const isInsideZone = (realPath: string, zoneRoot: string): boolean => {
  const relativePath = path.relative(zoneRoot, realPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
};

const isLexicallyInsideWorkspace = (
  resolvedPath: string,
  workspacePath: string,
): boolean => isInsideZone(resolvedPath, path.resolve(workspacePath));

const isInsideConfiguredCanonicalZone = async (
  targetRealPath: string,
  workspaceRealPath: string,
): Promise<boolean> => {
  if (isInsideZone(targetRealPath, workspaceRealPath)) {
    return true;
  }

  for (const [rootIndex, configuredRoot] of ALLOWED_SYMLINK_ROOTS.entries()) {
    try {
      const canonicalRoot = await fs.promises.realpath(configuredRoot);
      if (isInsideZone(targetRealPath, canonicalRoot)) {
        return true;
      }
    } catch (error) {
      // A root that cannot be identified cannot authorise a path; other roots
      // remain usable, matching the host file tools' fail-soft root handling.
      logger.warn(
        '[openai-image] Skipping an unavailable allowed symlink root.',
        { rootIndex, code: getErrorCode(error) ?? 'UNKNOWN' },
      );
    }
  }

  return false;
};

const formatWorkspaceContainmentError = (
  subject: string,
  inputPath: string,
  workspacePath: string,
  reason: 'outside' | 'unverifiable' = 'outside',
): WorkspaceFenceToolError => {
  const message =
    reason === 'outside'
      ? `${subject} is outside your workspace and folders linked as Spaces. Path: ${envelopeToolInput(inputPath)}. Workspace: ${workspacePath}.`
      : `${subject} could not be verified safely. Path: ${envelopeToolInput(inputPath)}. Workspace: ${workspacePath}.`;
  return new WorkspaceFenceToolError(
    message,
    'Move or copy the file into your workspace or a folder linked as a Space, then try again.',
  );
};

const canonicalizeDeepestExistingAncestor = async (
  targetPath: string,
): Promise<string> => {
  let candidatePath = path.resolve(targetPath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const canonicalAncestor = await fs.promises.realpath(candidatePath);
      return path.resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }

      const parentPath = path.dirname(candidatePath);
      if (parentPath === candidatePath) {
        throw error;
      }
      missingSegments.unshift(path.basename(candidatePath));
      candidatePath = parentPath;
    }
  }
};

const ensureOutputDirectoryIsAllowed = async (
  saveDir: string,
): Promise<void> => {
  const workspacePath = WORKSPACE_PATH;
  if (!workspacePath) {
    return;
  }

  const resolvedSaveDir = path.resolve(saveDir);
  if (!isLexicallyInsideWorkspace(resolvedSaveDir, workspacePath)) {
    throw formatWorkspaceContainmentError(
      'Generated image folder',
      saveDir,
      workspacePath,
    );
  }

  let workspaceRealPath: string;
  let prospectiveRealPath: string;
  try {
    [workspaceRealPath, prospectiveRealPath] = await Promise.all([
      fs.promises.realpath(workspacePath),
      canonicalizeDeepestExistingAncestor(resolvedSaveDir),
    ]);
  } catch {
    throw formatWorkspaceContainmentError(
      'Generated image folder',
      saveDir,
      workspacePath,
      'unverifiable',
    );
  }

  if (
    !(await isInsideConfiguredCanonicalZone(
      prospectiveRealPath,
      workspaceRealPath,
    ))
  ) {
    throw formatWorkspaceContainmentError(
      'Generated image folder',
      saveDir,
      workspacePath,
    );
  }
};

// After `mkdir` the output directory exists, so its canonical path can be
// resolved in full (no deepest-existing-ancestor approximation). Re-verify
// containment against that canonical path and return it; the write path then
// compares the directory's canonical identity again after opening the output
// file, closing the check-then-use window between validation and write.
const canonicalizeAllowedOutputDirectory = async (
  saveDir: string,
): Promise<string> => {
  const workspacePath = WORKSPACE_PATH;

  let canonicalDir: string;
  try {
    canonicalDir = await fs.promises.realpath(saveDir);
  } catch (error) {
    if (!workspacePath) {
      throw new OpenAIImageToolError(
        'WRITE_FAILED',
        'Failed to access the generated image folder.',
        'Check folder permissions and available disk space, then try again.',
      );
    }
    throw formatWorkspaceContainmentError(
      'Generated image folder',
      saveDir,
      workspacePath,
      'unverifiable',
    );
  }

  if (!workspacePath) {
    return canonicalDir;
  }

  let workspaceRealPath: string;
  try {
    workspaceRealPath = await fs.promises.realpath(workspacePath);
  } catch {
    throw formatWorkspaceContainmentError(
      'Generated image folder',
      saveDir,
      workspacePath,
      'unverifiable',
    );
  }

  if (!(await isInsideConfiguredCanonicalZone(canonicalDir, workspaceRealPath))) {
    throw formatWorkspaceContainmentError(
      'Generated image folder',
      saveDir,
      workspacePath,
    );
  }

  return canonicalDir;
};

export const resolveWorkspaceScopedImagePath = async (
  inputPath: string,
  imageLabel: string,
): Promise<
  | { resolvedPath: string; realPath: string; workspaceReal: string }
  | {
      errorText: string;
      safeFenceResolution?: string;
    }
> => {
  const workspaceBase = WORKSPACE_PATH;
  if (!workspaceBase) {
    return {
      errorText:
        'Image path handling requires a workspace. Open or create a workspace first.',
    };
  }

  const resolvedPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workspaceBase, inputPath);

  if (!isLexicallyInsideWorkspace(resolvedPath, workspaceBase)) {
    const fenceError = formatWorkspaceContainmentError(
      imageLabel,
      inputPath,
      workspaceBase,
    );
    return {
      errorText: fenceError.message,
      safeFenceResolution: fenceError.resolution,
    };
  }

  let workspaceReal: string;
  try {
    workspaceReal = await fs.promises.realpath(workspaceBase);
  } catch (error) {
    return { errorText: getWorkspacePathResolutionError(workspaceBase, error) };
  }

  let targetReal: string;
  try {
    targetReal = await fs.promises.realpath(resolvedPath);
  } catch (error) {
    return { errorText: getLocalImageReadError(imageLabel, inputPath, error) };
  }

  if (!(await isInsideConfiguredCanonicalZone(targetReal, workspaceReal))) {
    const fenceError = formatWorkspaceContainmentError(
      imageLabel,
      inputPath,
      workspaceBase,
    );
    return {
      errorText: fenceError.message,
      safeFenceResolution: fenceError.resolution,
    };
  }

  return { resolvedPath, realPath: targetReal, workspaceReal };
};

export const getSupportedImageMime = (filePath: string): string | null => {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
};

const workspaceFenceError = (
  rawErrorText: string,
  safeFenceResolution?: string,
): OpenAIImageToolError => {
  if (safeFenceResolution) {
    return new WorkspaceFenceToolError(rawErrorText, safeFenceResolution);
  }

  const sanitized = sanitizeUserFacingText(rawErrorText);
  const suffix = sanitized.toLowerCase().includes('outside your workspace')
    ? 'Move or copy the file into your workspace and try again.'
    : 'Check the file path and workspace access, then try again.';
  return new OpenAIImageToolError(
    'WORKSPACE_FENCE_VIOLATION',
    sanitized,
    suffix,
  );
};

const loadLocalEditImage = async (
  inputPath: string,
  options?: { pngOnly?: boolean },
): Promise<LoadedLocalImage> => {
  const imageLabel = options?.pngOnly ? 'Mask image' : 'Reference image';
  const safeInputPath = envelopeToolInput(inputPath);
  const resolvedPathResult = await resolveWorkspaceScopedImagePath(
    inputPath,
    imageLabel,
  );
  if ('errorText' in resolvedPathResult) {
    throw workspaceFenceError(
      resolvedPathResult.errorText,
      resolvedPathResult.safeFenceResolution,
    );
  }

  const { resolvedPath, realPath, workspaceReal } = resolvedPathResult;
  const extension = path.extname(realPath).toLowerCase();

  if (options?.pngOnly && extension !== '.png') {
    throw workspaceFenceError('Mask image must be a PNG file.');
  }

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(realPath);
  } catch (error) {
    throw workspaceFenceError(getLocalImageReadError(imageLabel, inputPath, error));
  }

  if (stats.size === 0) {
    throw workspaceFenceError(`${imageLabel} is empty (0 bytes): ${safeInputPath}`);
  }

  if (stats.size > MAX_LOCAL_IMAGE_BYTES) {
    throw workspaceFenceError(`${imageLabel} exceeds 25MB limit: ${safeInputPath}`);
  }

  const mime = options?.pngOnly ? 'image/png' : getSupportedImageMime(realPath);
  if (!mime) {
    throw workspaceFenceError(
      `Unsupported image type: ${envelopeToolInput(extension || path.basename(resolvedPath))}. Supported: PNG, JPEG, WEBP.`,
    );
  }

  // Open-then-validate (closes the MED-1 check-then-use window): the fence
  // validated the canonical path above, but reading by path afterwards would
  // let a local race swap the file between check and read. Open a descriptor,
  // confirm it is the same inode the baseline stat observed, and read through
  // the descriptor so a path swap cannot redirect the read outside the fence.
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(resolvedPath, 'r');
    const openedStats = await handle.stat();
    if (openedStats.dev !== stats.dev || openedStats.ino !== stats.ino) {
      throw workspaceFenceError(
        `${imageLabel} changed while it was being verified: ${safeInputPath}`,
      );
    }

    // Bind the fence decision to the opened inode (F-1): the baseline stat
    // above is captured after the fence through the same pathname, so a
    // symlink swapped in post-fence would pass the dev/ino agreement check on
    // its out-of-fence target. Now that the descriptor pins the inode,
    // re-resolve the canonical path and require it to be byte-identical to the
    // path the fence approved — a swap (or swap-back) that changed what the
    // pathname resolves to is caught here. Reads then flow through the pinned
    // descriptor, so a later swap cannot redirect them.
    //
    // realpathSync/lstatSync on purpose: the async pair would be two libuv
    // work items separated by a full event-loop turn — an attacker-widenable
    // window (threadpool contention, FUSE stalls). The sync pair runs as two
    // adjacent syscalls on this thread, shrinking the decisive realpath→lstat
    // window to the minimum Node allows without openat. The blocking cost of
    // two tiny stats is negligible.
    const postOpenRealPath = fs.realpathSync(resolvedPath);
    if (postOpenRealPath !== realPath) {
      throw workspaceFenceError(
        `${imageLabel} changed while it was being verified: ${safeInputPath}`,
      );
    }

    // Require the canonical path to still name the pinned inode. lstat (not
    // stat): a canonical path has no symlink leaf by construction, so a leaf
    // swapped for a symlink between the realpath and this call is exposed as
    // an inode mismatch instead of being followed to the attacker's target.
    const postOpenStats = fs.lstatSync(postOpenRealPath);
    if (
      postOpenStats.dev !== openedStats.dev ||
      postOpenStats.ino !== openedStats.ino
    ) {
      throw workspaceFenceError(
        `${imageLabel} changed while it was being verified: ${safeInputPath}`,
      );
    }

    // On Linux, ask the kernel for the canonical path of the pinned inode
    // itself and re-check containment on that: /proc/self/fd resolves the
    // descriptor, not the (raceable) pathname, so no path re-resolution window
    // remains. Residual, documented in the README security notes: on platforms
    // without /proc (and without openat/F_GETPATH in Node) a
    // directory-component swap timed between the realpath and lstat above can
    // still redirect the lstat — the same unclosable-syscall-instant class as
    // the write side's check→link window. The hardlink blind spot
    // (canonical-prefix containment cannot see hard links) is a pre-existing,
    // cohort-wide platform limitation, unchanged.
    if (process.platform === 'linux') {
      let descriptorPath: string;
      try {
        descriptorPath = await fs.promises.realpath(
          `/proc/self/fd/${handle.fd}`,
        );
      } catch (error) {
        // Distinguish a missing /proc (minimal container/chroot — an
        // environment problem the operator must fix) from a raced or deleted
        // image path (an ordinary read failure).
        if (!fs.existsSync('/proc/self/fd')) {
          throw workspaceFenceError(
            `${imageLabel} could not be verified safely: the /proc filesystem is unavailable in this environment, so the workspace fence cannot pin the opened file: ${safeInputPath}`,
          );
        }
        throw workspaceFenceError(
          getLocalImageReadError(imageLabel, inputPath, error),
        );
      }
      if (
        !(await isInsideConfiguredCanonicalZone(descriptorPath, workspaceReal))
      ) {
        throw workspaceFenceError(
          `${imageLabel} changed while it was being verified: ${safeInputPath}`,
        );
      }
    }
    if (openedStats.size === 0) {
      throw workspaceFenceError(`${imageLabel} is empty (0 bytes): ${safeInputPath}`);
    }
    if (openedStats.size > MAX_LOCAL_IMAGE_BYTES) {
      throw workspaceFenceError(`${imageLabel} exceeds 25MB limit: ${safeInputPath}`);
    }

    const data = await handle.readFile();
    if (data.length === 0 || data.length > MAX_LOCAL_IMAGE_BYTES) {
      throw workspaceFenceError(
        `${imageLabel} size changed while it was being read: ${safeInputPath}`,
      );
    }

    return {
      path: realPath,
      filename: path.basename(resolvedPath),
      mime,
      data,
    };
  } catch (error) {
    if (error instanceof OpenAIImageToolError) {
      throw error;
    }
    throw workspaceFenceError(getLocalImageReadError(imageLabel, inputPath, error));
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const parseOpenAIErrorMessage = async (response: Response): Promise<string> => {
  try {
    const parsed = (await response.clone().json()) as OpenAIErrorData;
    return parsed.error?.message ?? '';
  } catch {
    return '';
  }
};

const toOpenAIHttpError = (
  status: number,
  upstreamMessage: string,
  model: string,
): OpenAIImageToolError => {
  const lowered = upstreamMessage.toLowerCase();

  if (lowered.includes('content policy')) {
    return new OpenAIImageToolError(
      'CONTENT_POLICY',
      'Content policy violation. Please try a different prompt.',
      'Revise the prompt and try again.',
    );
  }

  if (status === 401) {
    return new OpenAIImageToolError(
      'INVALID_API_KEY',
      'Invalid OpenAI API key.',
      NOT_CONFIGURED_RESOLUTION,
    );
  }

  if (status === 429) {
    return new OpenAIImageToolError(
      'RATE_LIMITED',
      'Rate limit exceeded for the OpenAI image API.',
      'Wait a moment and try again.',
    );
  }

  if (status === 403) {
    return new OpenAIImageToolError(
      'MODEL_UNAVAILABLE',
      `This OpenAI account is not verified for model ${envelopeConfiguredModel(model)}.`,
      'Verify your OpenAI organization access for this model, or switch OPENAI_IMAGE_MODEL.',
    );
  }

  return new OpenAIImageToolError(
    'NETWORK_ERROR',
    `OpenAI image API request failed with status ${status}.`,
    'Try again in a moment. If this persists, check OpenAI status and your account permissions.',
  );
};

interface FetchAbortController {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

const buildFetchController = (callerSignal?: AbortSignal): FetchAbortController => {
  const controller = new AbortController();
  let didTimeout = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, OPENAI_IMAGE_REQUEST_TIMEOUT_MS);

  const onCallerAbort = (): void => {
    controller.abort();
  };
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (callerSignal) {
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
    },
  };
};

const networkOrTimeoutError = (controller: FetchAbortController): OpenAIImageToolError => {
  if (controller.timedOut()) {
    return new OpenAIImageToolError(
      'TIMEOUT',
      `OpenAI image API request exceeded the ${Math.round(OPENAI_IMAGE_REQUEST_TIMEOUT_MS / 1000)}s timeout.`,
      "Retry once. For a faster draft, retry with quality: 'medium'.",
    );
  }
  return new OpenAIImageToolError(
    'NETWORK_ERROR',
    'Failed to reach OpenAI image API.',
    'Check your network connection and try again.',
  );
};

const parseOpenAIImageResponse = async (
  response: Response,
): Promise<OpenAIImageResponse> => {
  const parsedBody = openAIImageResponseSchema.safeParse(await response.json());
  if (!parsedBody.success) {
    throw new OpenAIImageToolError(
      'NETWORK_ERROR',
      'OpenAI image API returned an unexpected response.',
      'Try again in a moment. If this persists, check OpenAI status and your account permissions.',
    );
  }
  return parsedBody.data;
};

const postOpenAIJson = async (
  endpointPath: string,
  apiKey: string,
  body: Record<string, unknown>,
  model: string,
  callerSignal?: AbortSignal,
): Promise<OpenAIImageResponse> => {
  const controller = buildFetchController(callerSignal);

  let response: Response;
  try {
    response = await fetch(`${OPENAI_API_BASE_URL}${endpointPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw networkOrTimeoutError(controller);
  } finally {
    controller.cleanup();
  }

  if (!response.ok) {
    const message = await parseOpenAIErrorMessage(response);
    throw toOpenAIHttpError(response.status, message, model);
  }

  return parseOpenAIImageResponse(response);
};

const postOpenAIMultipart = async (
  endpointPath: string,
  apiKey: string,
  form: FormData,
  model: string,
  callerSignal?: AbortSignal,
): Promise<OpenAIImageResponse> => {
  const controller = buildFetchController(callerSignal);

  let response: Response;
  try {
    response = await fetch(`${OPENAI_API_BASE_URL}${endpointPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
  } catch {
    throw networkOrTimeoutError(controller);
  } finally {
    controller.cleanup();
  }

  if (!response.ok) {
    const message = await parseOpenAIErrorMessage(response);
    throw toOpenAIHttpError(response.status, message, model);
  }

  return parseOpenAIImageResponse(response);
};

interface ImageOutputOptions {
  output_format?: 'png' | 'jpeg' | 'webp' | undefined;
  output_compression?: number | undefined;
}

interface ResolvedOutputOptions {
  outputFormat: 'png' | 'jpeg' | 'webp';
  outputExtension: string;
  outputMime: string;
  outputCompression?: number | undefined;
}

const resolveOutputOptions = (input: ImageOutputOptions): ResolvedOutputOptions => {
  const outputFormat = input.output_format ?? 'png';
  if (input.output_compression !== undefined && outputFormat === 'png') {
    throw new OpenAIImageToolError(
      'INVALID_INPUT',
      'output_compression only applies when output_format is jpeg or webp.',
      "Set output_format to 'jpeg' or 'webp', or omit output_compression.",
    );
  }
  return {
    outputFormat,
    outputExtension: OUTPUT_FORMAT_EXTENSIONS[outputFormat] ?? 'png',
    outputMime: OUTPUT_FORMAT_MIME[outputFormat] ?? 'image/png',
    outputCompression: input.output_compression,
  };
};

const ensureTransparentBackgroundSupported = (
  background: 'transparent' | 'opaque' | 'auto' | undefined,
  outputFormat: string,
  model: string,
): void => {
  if (background !== 'transparent') {
    return;
  }

  if (outputFormat === 'jpeg') {
    throw new OpenAIImageToolError(
      'INVALID_INPUT',
      "background: 'transparent' requires an output format that supports transparency.",
      "Set output_format to 'png' or 'webp', or omit output_format (png is the default).",
    );
  }

  if (modelKnownToRejectTransparency(model)) {
    throw new OpenAIImageToolError(
      'INVALID_INPUT',
      `Model ${envelopeConfiguredModel(model)} does not support transparent backgrounds.`,
      'Set OPENAI_IMAGE_MODEL to gpt-image-1.5 (or gpt-image-1), or omit the background option.',
    );
  }
};

const generateImageSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('Text description of the image to generate'),
  size: z
    .enum(['square', 'portrait', 'landscape'])
    .optional()
    .describe(
      'Image dimensions: square (1024x1024), portrait (1024x1536), landscape (1536x1024)',
    ),
  quality: z
    .enum(['low', 'medium', 'high', 'auto'])
    .optional()
    .describe(
      'Image quality (defaults to high). Medium is usually about 50 seconds and $0.04; high can take up to 3 minutes and cost about $0.21.',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe(
      'How many images to generate (1-8). Cost multiplies by count.',
    ),
  moderation: z
    .enum(['auto', 'low'])
    .optional()
    .describe('Content moderation strictness (defaults to auto).'),
  output_format: z
    .enum(['png', 'jpeg', 'webp'])
    .optional()
    .describe(
      "Output file format (defaults to png). jpeg and webp produce smaller files; only png and webp support transparency.",
    ),
  output_compression: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Compression level 0-100 (higher = better quality, larger file). Only applies when output_format is jpeg or webp.',
    ),
  background: z
    .enum(['transparent', 'opaque', 'auto'])
    .optional()
    .describe(
      "Background style. 'transparent' produces a cutout with an alpha channel; it requires png or webp output and a transparency-capable model (gpt-image-1.x — gpt-image-2 rejects it).",
    ),
});

const editImageSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      'What to change in the image. Describe the edit in plain language.',
    ),
  image_paths: z
    .array(z.string().min(1))
    .min(1)
    .max(4)
    .describe(
      'Absolute or workspace-relative paths to reference images. PNG/JPEG/WEBP only.',
    ),
  mask_path: z
    .string()
    .optional()
    .describe(
      'Optional PNG mask. Transparent areas define the edit region.',
    ),
  size: z
    .enum(['square', 'portrait', 'landscape'])
    .optional()
    .describe('Output dimensions.'),
  quality: z
    .enum(['low', 'medium', 'high', 'auto'])
    .optional()
    .describe(
      'Output quality (defaults to high). Medium is usually about 50 seconds and $0.04; high can take up to 3 minutes and cost about $0.21.',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe('How many output images to generate (1-8).'),
  moderation: z
    .enum(['auto', 'low'])
    .optional()
    .describe('Content moderation strictness (defaults to auto).'),
  output_format: z
    .enum(['png', 'jpeg', 'webp'])
    .optional()
    .describe(
      'Output file format (defaults to png). jpeg and webp produce smaller files; only png and webp support transparency.',
    ),
  output_compression: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Compression level 0-100 (higher = better quality, larger file). Only applies when output_format is jpeg or webp.',
    ),
  background: z
    .enum(['transparent', 'opaque', 'auto'])
    .optional()
    .describe(
      "Background style. 'transparent' produces a cutout with an alpha channel; it requires png or webp output and a transparency-capable model (gpt-image-1.x — gpt-image-2 rejects it).",
    ),
});

const toolSuccessText = (
  action: 'generated' | 'edited',
  savedPaths: string[],
  requestedCount: number,
): string => {
  if (savedPaths.length === 0) {
    return `No usable images were ${action}.`;
  }

  const baseVerb = action === 'generated' ? 'Generated' : 'Edited';
  const noun = savedPaths.length === 1 ? 'image' : 'images';
  const lines = [`${baseVerb} ${savedPaths.length} ${noun}, saved to:`];
  for (const savedPath of savedPaths) {
    lines.push(`  ${savedPath}`);
  }

  if (savedPaths.length < requestedCount) {
    lines.push(
      `Requested ${requestedCount}, but only ${savedPaths.length} image(s) were usable.`,
    );
  }

  if (savedPaths.length > MAX_INLINE_IMAGES) {
    lines.push(
      `Previewing first ${MAX_INLINE_IMAGES} inline; see file paths for the rest.`,
    );
  }

  return lines.join('\n');
};

const mapResponseImages = async (
  images: OpenAIImageResponse['data'],
  saveDir: string,
  prompt: string,
  requestedCount: number,
  extension: string = 'png',
): Promise<Array<{ path: string; b64: string }>> => {
  if (!images || images.length === 0) {
    throw new OpenAIImageToolError(
      'NETWORK_ERROR',
      'No image data returned from OpenAI.',
      'Try again with a different prompt.',
    );
  }

  const saved: Array<{ path: string; b64: string }> = [];
  for (const [index, imageData] of images.entries()) {
    const b64 = imageData?.b64_json;
    if (!b64) {
      continue;
    }

    validateBase64ImageData(b64);
    const savedPath = await saveImageToDisk(
      saveDir,
      prompt,
      b64,
      index,
      requestedCount,
      extension,
    );
    saved.push({ path: savedPath, b64 });
  }

  if (saved.length === 0) {
    throw new OpenAIImageToolError(
      'INVALID_IMAGE_DATA',
      'No valid image payloads were returned from OpenAI.',
      'Try again with a different prompt.',
    );
  }

  return saved;
};

const registerTools = (targetServer: McpServer): void => {
  targetServer.registerTool(
    'generate_image',
    {
      title: 'Generate Image',
      description:
        "Generate one or more images using OpenAI's gpt-image-2 family and save outputs to your workspace.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      inputSchema: generateImageSchema,
    },
    async (input, context): Promise<CallToolResult> =>
      withErrorHandling(async () => {
        const apiKey = ensureConfiguredApiKey();
        const model = configuredModel();
        const size = input.size ?? 'square';
        const quality = input.quality ?? 'high';
        const count = input.count ?? 1;
        const moderation = resolveModeration(input.moderation);
        const { outputFormat, outputExtension, outputMime, outputCompression } =
          resolveOutputOptions(input);
        ensureTransparentBackgroundSupported(input.background, outputFormat, model);

        const body: Record<string, unknown> = {
          model,
          prompt: input.prompt,
          n: count,
          size: SIZE_MAP[size] || '1024x1024',
          quality,
        };

        if (modelSupportsModeration(model)) {
          body.moderation = moderation;
        }
        if (input.output_format) {
          body.output_format = outputFormat;
        }
        if (outputCompression !== undefined) {
          body.output_compression = outputCompression;
        }
        if (input.background) {
          body.background = input.background;
        }

        logger.info('[openai-image] Sending generate request.', {
          size,
          quality,
          count,
          model,
          outputFormat,
        });

        const data = await postOpenAIJson(
          '/v1/images/generations',
          apiKey,
          body,
          model,
          (context as ToolCallbackContext | undefined)?.signal,
        );
        const saveDir = await getImageSaveDir();
        const savedImages = await mapResponseImages(
          data.data,
          saveDir,
          input.prompt,
          count,
          outputExtension,
        );

        const textMessage = toolSuccessText(
          'generated',
          savedImages.map((entry) => entry.path),
          count,
        );
        const inlineImages = savedImages
          .slice(0, MAX_INLINE_IMAGES)
          .map(({ b64 }) => ({
            type: 'image' as const,
            data: b64,
            mimeType: outputMime,
          }));

        return {
          content: [{ type: 'text' as const, text: textMessage }, ...inlineImages],
        };
      }),
  );

  targetServer.registerTool(
    'edit_image',
    {
      title: 'Edit Image',
      description:
        'Edit one or more existing images with OpenAI image editing and save outputs to your workspace.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      inputSchema: editImageSchema,
    },
    async (input, context): Promise<CallToolResult> =>
      withErrorHandling(async () => {
        const apiKey = ensureConfiguredApiKey();
        const model = configuredModel();
        const size = input.size ?? 'square';
        const quality = input.quality ?? 'high';
        const count = input.count ?? 1;
        const moderation = resolveModeration(input.moderation);
        const { outputFormat, outputExtension, outputMime, outputCompression } =
          resolveOutputOptions(input);
        ensureTransparentBackgroundSupported(input.background, outputFormat, model);

        const referenceImages: LoadedLocalImage[] = [];
        for (const imagePath of input.image_paths) {
          referenceImages.push(await loadLocalEditImage(imagePath));
        }

        let maskImage: LoadedLocalImage | null = null;
        if (input.mask_path) {
          maskImage = await loadLocalEditImage(input.mask_path, { pngOnly: true });
        }

        const form = new FormData();
        for (const referenceImage of referenceImages) {
          form.append(
            'image[]',
            new Blob([new Uint8Array(referenceImage.data)], {
              type: referenceImage.mime,
            }),
            referenceImage.filename,
          );
        }
        if (maskImage) {
          form.append(
            'mask',
            new Blob([new Uint8Array(maskImage.data)], { type: 'image/png' }),
            maskImage.filename,
          );
        }

        form.append('prompt', input.prompt);
        form.append('model', model);
        form.append('size', SIZE_MAP[size] || '1024x1024');
        form.append('quality', quality);
        form.append('n', String(count));
        if (modelSupportsModeration(model)) {
          form.append('moderation', moderation);
        }
        if (input.output_format) {
          form.append('output_format', outputFormat);
        }
        if (outputCompression !== undefined) {
          form.append('output_compression', String(outputCompression));
        }
        if (input.background) {
          form.append('background', input.background);
        }

        logger.info('[openai-image] Sending edit request.', {
          size,
          quality,
          count,
          model,
          outputFormat,
          referenceCount: referenceImages.length,
          hasMask: !!maskImage,
        });

        const data = await postOpenAIMultipart(
          '/v1/images/edits',
          apiKey,
          form,
          model,
          (context as ToolCallbackContext | undefined)?.signal,
        );
        const saveDir = await getImageSaveDir();
        const savedImages = await mapResponseImages(
          data.data,
          saveDir,
          input.prompt,
          count,
          outputExtension,
        );

        const textMessage = toolSuccessText(
          'edited',
          savedImages.map((entry) => entry.path),
          count,
        );
        const inlineImages = savedImages
          .slice(0, MAX_INLINE_IMAGES)
          .map(({ b64 }) => ({
            type: 'image' as const,
            data: b64,
            mimeType: outputMime,
          }));

        return {
          content: [{ type: 'text' as const, text: textMessage }, ...inlineImages],
        };
      }),
  );
};

export const createServer = (): McpServer => {
  const server = new McpServer({
    name: 'OpenAIImageGeneration',
    version: SERVER_VERSION,
  });
  registerTools(server);
  return server;
};

export const isLoopbackHost = (host?: string): boolean => {
  if (!host) return false;
  return (
    /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/iu.test(host) ||
    /^\[::1\](?::\d{1,5})?$/u.test(host)
  );
};

export const readJsonBody = async (
  req: http.IncomingMessage,
): Promise<unknown> => {
  if (req.method !== 'POST') {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    return undefined;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
};

const startStdioMode = async (): Promise<void> => {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('[openai-image] Server started on stdio.');
};

const startHttpMode = async (port: number): Promise<void> => {
  const httpServer = http.createServer(async (req, res) => {
    if (!isLoopbackHost(req.headers.host)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Forbidden host');
      return;
    }

    const requestServer = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await requestServer.connect(transport);
      const body = await readJsonBody(req);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error('[openai-image] HTTP request error.', { error });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error');
      }
    } finally {
      await transport.close().catch(() => undefined);
      await requestServer.close().catch(() => undefined);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', onError);
      logger.info('[openai-image] HTTP mode listening on loopback.', { port });
      resolve();
    });
  });

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

const main = async (): Promise<void> => {
  logger.info('[openai-image] Starting server.', {
    model: configuredModel(),
    requestTimeoutMs: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
    hasApiKey: !!configuredApiKey(),
  });

  const httpPort = process.env.MCP_HTTP_PORT;
  if (httpPort) {
    const parsedPort = parseInt(httpPort, 10);
    if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
      throw new OpenAIImageToolError(
        'NETWORK_ERROR',
        `Invalid MCP_HTTP_PORT: ${sanitizeUserFacingText(httpPort)}`,
        'Set MCP_HTTP_PORT to a valid positive integer.',
      );
    }
    await startHttpMode(parsedPort);
  } else {
    await startStdioMode();
  }
};

if (process.env.OPENAI_IMAGE_IMPORT_ONLY !== '1') {
  main().catch((error) => {
    logger.error('[openai-image] Failed to start server.', { error });
    process.exit(1);
  });
}
