import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConnectorError } from './types.js';

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Derive the canonical workspace root for files the connector reads from or
 * writes to on behalf of the model (`browser_pdf` output, `browser_upload`
 * sources).
 *
 * Mirrors the pandadoc connector's sandbox helper:
 *   - Use `MCP_WORKSPACE_PATH` if set and non-empty, else `os.tmpdir()`.
 *   - The root is canonicalised through `fs.realpathSync` so the prefix
 *     checks are stable on platforms where the tmpdir itself is reached
 *     through a symlink (macOS: `/tmp` → `/private/tmp`).
 *   - If `realpathSync` fails (e.g. the env var points at a non-existent
 *     directory), FAIL CLOSED: a root we cannot canonicalise makes every
 *     downstream containment check unreliable, so file operations are
 *     refused. The failed pre-check is made observable via a stderr warning.
 */
export function getWorkspaceRoot(): string {
  const envRoot = process.env.MCP_WORKSPACE_PATH;
  const explicit = Boolean(envRoot && envRoot.trim());
  const raw = explicit ? envRoot!.trim() : os.tmpdir();
  const lexical = path.resolve(raw);
  try {
    return fs.realpathSync(lexical);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[browser-automation] Workspace root ${JSON.stringify(lexical)} cannot be canonicalised (${reason}); refusing file operations.`,
    );
    throw new ConnectorError(
      explicit
        ? `MCP_WORKSPACE_PATH (${lexical}) cannot be resolved: ${reason}`
        : `System temp directory (${lexical}) cannot be resolved: ${reason}`,
      'WORKSPACE_ROOT_UNAVAILABLE',
      'Set MCP_WORKSPACE_PATH to an existing directory the process can read, or unset it to use the system temp directory.',
    );
  }
}

/**
 * Canonicalise the deepest existing ancestor of an absolute path and
 * re-append the missing tail. This lets the lexical-prefix containment check
 * accept in-workspace paths supplied via a symlinked alias of the workspace
 * root (e.g. `/tmp` → `/private/tmp` on macOS) while still rejecting `..`
 * traversal and out-of-root absolutes deterministically WITHOUT requiring
 * the leaf to exist.
 */
function canonicalisePrefix(absoluteLexical: string): string {
  const tail: string[] = [];
  let cur = absoluteLexical;
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return absoluteLexical;
    }
    tail.push(path.basename(cur));
    cur = parent;
  }
}

function isInsideRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

function absolutise(inputPath: string, root: string): string {
  const expanded = inputPath.startsWith('~')
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  // Relative inputs resolve against the workspace root — an MCP server's
  // process cwd is unpredictable, so anchoring anywhere else would be
  // arbitrary. Absolute inputs must still land inside the root.
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(root, expanded);
}

/**
 * Validate that `inputPath` resolves to a real file inside the workspace
 * root, even after symlink resolution (for `browser_upload` sources).
 * Returns the canonical path on success.
 */
export function resolveWorkspaceReadPath(inputPath: string): ResolveResult {
  const root = getWorkspaceRoot();
  const lexical = absolutise(inputPath, root);

  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(canonicalCandidate, root)) {
    return { ok: false, error: `file_path is outside the workspace sandbox root (${root}). Got: ${inputPath}` };
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `File not found: ${inputPath}` };
    }
    throw err;
  }

  if (!isInsideRoot(canonical, root)) {
    return {
      ok: false,
      error:
        `file_path resolves outside the workspace sandbox root (${root}); ` +
        `symlinks may not escape the workspace. Got: ${inputPath}`,
    };
  }

  return { ok: true, path: canonical };
}

/**
 * Validate that `inputPath` is a safe WRITE target inside the workspace
 * root (for `browser_pdf` output). The leaf need not exist yet; when it
 * does exist it must not be a symlink escaping the workspace.
 */
export function resolveWorkspaceWritePath(inputPath: string): ResolveResult {
  const root = getWorkspaceRoot();
  const lexical = absolutise(inputPath, root);

  // Deepest-existing-ancestor canonicalisation catches `..` traversal,
  // out-of-root absolutes, and symlinked intermediate directories pointing
  // outside the root — all without requiring the leaf file to exist.
  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(canonicalCandidate, root)) {
    return { ok: false, error: `file_path is outside the workspace sandbox root (${root}). Got: ${inputPath}` };
  }

  // If the leaf itself exists as a symlink, resolve it too so a planted
  // symlink cannot redirect the write outside the workspace.
  try {
    const canonicalLeaf = fs.realpathSync(lexical);
    if (!isInsideRoot(canonicalLeaf, root)) {
      return {
        ok: false,
        error:
          `file_path resolves outside the workspace sandbox root (${root}); ` +
          `symlinks may not escape the workspace. Got: ${inputPath}`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  return { ok: true, path: canonicalCandidate };
}

const STAGING_DIR_MODE = 0o700;
const STAGING_FILE_MODE = 0o600;
const COPY_CHUNK_BYTES = 1024 * 1024;

/**
 * Create a fresh, unpredictable staging directory directly under the
 * canonical workspace root (mode 0700). Because it is created atomically
 * with a random suffix, another local principal cannot pre-create, rename,
 * or symlink-swap any component of paths inside it — which is what makes a
 * staged file swap-proof between our write and the agent-browser CLI's
 * later open. The validated user-supplied pathname is never re-trusted.
 */
export function createStagingDir(prefix: string): string {
  const root = getWorkspaceRoot();
  const dir = fs.mkdtempSync(path.join(root, prefix));
  fs.chmodSync(dir, STAGING_DIR_MODE);
  return dir;
}

/** Best-effort removal of a staging directory and everything in it. */
export function discardStagingDir(stagingDir: string): void {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

function sanitiseBasename(p: string, fallback: string): string {
  const base = path.basename(p);
  return base === '' || base === '.' || base === '..' ? fallback : base;
}

/**
 * Stage one `browser_upload` source into `stagingDir` and return the path
 * the CLI should consume.
 *
 * The source is validated inside the workspace root, then opened EXACTLY
 * ONCE and fstat-verified through that fd to be a regular file —
 * directories, FIFOs, sockets, and devices pass realpathSync but must not
 * become upload payloads. The content is streamed through the same fd into
 * a private staging slot carrying over only the requested basename, so the
 * CLI never re-opens the validated pathname and a post-validation swap of
 * the original cannot redirect the upload.
 */
export function stageUploadSource(inputPath: string, stagingDir: string, index: number): string {
  const resolved = resolveWorkspaceReadPath(inputPath);
  if (!resolved.ok) {
    throw new ConnectorError(
      resolved.error,
      'PATH_OUTSIDE_WORKSPACE',
      'Pass file paths inside the workspace directory (MCP_WORKSPACE_PATH, or the system temp directory when unset).',
    );
  }

  const slot = path.join(stagingDir, String(index));
  fs.mkdirSync(slot, { mode: STAGING_DIR_MODE });
  const stagingPath = path.join(slot, sanitiseBasename(resolved.path, `upload-${index}`));

  const inFd = fs.openSync(resolved.path, 'r');
  try {
    const stat = fs.fstatSync(inFd);
    if (!stat.isFile()) {
      throw new ConnectorError(
        `file_path is not a regular file: ${inputPath}`,
        'NOT_A_REGULAR_FILE',
        'Pass a path to a regular file inside the workspace directory.',
      );
    }
    const outFd = fs.openSync(stagingPath, 'wx', STAGING_FILE_MODE);
    try {
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let bytesRead: number;
      do {
        bytesRead = fs.readSync(inFd, chunk, 0, chunk.length, null);
        if (bytesRead > 0) fs.writeSync(outFd, chunk, 0, bytesRead);
      } while (bytesRead > 0);
    } finally {
      fs.closeSync(outFd);
    }
  } finally {
    fs.closeSync(inFd);
  }
  return stagingPath;
}

export interface PdfStagingTarget {
  /** Validated final destination for the PDF. */
  destPath: string;
  /**
   * Canonical realpath of destPath's parent directory, pinned at validation
   * time (the parent is created before the CLI runs). installStagedFile
   * re-verifies it before writing, so an intermediate directory swapped to
   * a symlink during the CLI call is refused instead of followed outside
   * the workspace.
   */
  canonicalParentDir: string;
  /** Private staging path the CLI should write to. */
  stagingPath: string;
  /** Remove with discardStagingDir once installed (or on failure). */
  stagingDir: string;
}

/**
 * Resolve the `browser_pdf` destination and prepare a private staging
 * target. The CLI writes into the staging path — never the validated
 * pathname — so an attacker cannot redirect the write by swapping an
 * intermediate directory or leaf after validation.
 *
 * An existing destination is refused up front unless `overwrite` was
 * explicitly requested; installStagedFile enforces the same invariant
 * race-safely with exclusive-create at install time.
 */
export function createPdfStagingTarget(filePath: string, overwrite: boolean): PdfStagingTarget {
  const resolved = resolveWorkspaceWritePath(filePath);
  if (!resolved.ok) {
    throw new ConnectorError(
      resolved.error,
      'PATH_OUTSIDE_WORKSPACE',
      'Pass a file path inside the workspace directory (MCP_WORKSPACE_PATH, or the system temp directory when unset).',
    );
  }

  if (!overwrite && fs.existsSync(resolved.path)) {
    throw new ConnectorError(
      `file_path already exists: ${filePath}`,
      'FILE_EXISTS',
      'Pass overwrite: true to replace the existing file, or choose a different file_path.',
    );
  }

  // Create the parent directory NOW, before the multi-second CLI call, and
  // pin its canonical identity. resolved.path is canonical, so the realpath
  // of the freshly prepared parent must equal it exactly; a mismatch means
  // a component changed under us and the destination cannot be trusted.
  const parentDir = path.dirname(resolved.path);
  fs.mkdirSync(parentDir, { recursive: true });
  const canonicalParentDir = fs.realpathSync(parentDir);
  if (canonicalParentDir !== parentDir) {
    throw new ConnectorError(
      `file_path parent directory changed while it was being prepared: ${filePath}`,
      'PATH_OUTSIDE_WORKSPACE',
      'Retry the call, or choose a different file_path inside the workspace directory.',
    );
  }

  const stagingDir = createStagingDir('browser-pdf-');
  return {
    destPath: resolved.path,
    canonicalParentDir,
    stagingPath: path.join(stagingDir, sanitiseBasename(resolved.path, 'page.pdf')),
    stagingDir,
  };
}

/**
 * Install a staged PDF at its validated destination.
 *
 * Two defences, one per path component class:
 *   - Leaf: the install never writes through a pre-existing filesystem
 *     entry. Exclusive-create (COPYFILE_EXCL) fails with EEXIST on anything
 *     already at the destination — including a planted symlink. With
 *     `overwrite`, the old entry is removed first and the same
 *     exclusive-create follows, so a leaf swap planted in between surfaces
 *     as an EEXIST refusal instead of a write through an attacker-chosen
 *     path.
 *   - Intermediate directories: exclusive-create guards only the final
 *     component, so the parent's canonical identity (pinned at validation,
 *     before the CLI ran) is re-verified immediately before installing. A
 *     directory swapped to a symlink during the CLI call is refused rather
 *     than followed outside the workspace — for the write and, with
 *     `overwrite`, for the preceding delete. (A swap landing after this
 *     re-check but before the copy is a sub-millisecond residual window, on
 *     par with any local check-then-use race.)
 */
export function installStagedFile(target: PdfStagingTarget, overwrite: boolean): void {
  const { stagingPath, destPath, canonicalParentDir } = target;
  let staged: fs.Stats;
  try {
    staged = fs.lstatSync(stagingPath);
  } catch {
    throw new ConnectorError(
      'The agent-browser CLI did not produce an output file.',
      'CLI_ERROR',
      'Retry the call, or check that a page is open in the browser session.',
    );
  }
  if (!staged.isFile()) {
    throw new ConnectorError(
      'The agent-browser CLI did not produce a regular output file.',
      'CLI_ERROR',
      'Retry the call, or check that a page is open in the browser session.',
    );
  }

  const parentDir = path.dirname(destPath);
  let currentParentDir: string;
  try {
    currentParentDir = fs.realpathSync(parentDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConnectorError(
      `Destination directory cannot be resolved (${reason}): ${destPath}`,
      'PATH_OUTSIDE_WORKSPACE',
      'Retry the call, or choose a different file_path inside the workspace directory.',
    );
  }
  if (currentParentDir !== canonicalParentDir) {
    throw new ConnectorError(
      `Destination directory changed while the PDF was being generated: ${destPath}`,
      'PATH_OUTSIDE_WORKSPACE',
      'Retry the call, or choose a different file_path inside the workspace directory.',
    );
  }

  if (overwrite) {
    fs.rmSync(destPath, { force: true });
  }
  try {
    fs.copyFileSync(stagingPath, destPath, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ConnectorError(
        `Destination already exists: ${destPath}`,
        'FILE_EXISTS',
        'Pass overwrite: true to replace the existing file, or choose a different file_path.',
      );
    }
    throw err;
  }
}
