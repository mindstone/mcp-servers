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
 * A post-validation swap raced the upload source. Distinct from
 * PATH_OUTSIDE_WORKSPACE: the path WAS inside the workspace at validation
 * time, so retrying can succeed.
 */
function uploadSourceChangedError(inputPath: string): ConnectorError {
  return new ConnectorError(
    `file_path changed while it was being validated: ${inputPath}`,
    'UPLOAD_SOURCE_CHANGED',
    'Retry the call, or pass a path to a regular file inside the workspace directory.',
  );
}

/**
 * Stage one `browser_upload` source into `stagingDir` and return the path
 * the CLI should consume.
 *
 * The source is validated inside the workspace root, then opened EXACTLY
 * ONCE with O_NOFOLLOW — a leaf swapped for a symlink between validation
 * and open fails with ELOOP instead of being followed outside the
 * workspace — and O_NONBLOCK, so a planted FIFO cannot wedge the connector
 * by blocking the open until a writer appears. The fd is fstat-verified to
 * be a regular file (directories, FIFOs, sockets, and devices pass
 * realpathSync but must not become upload payloads), then bound to a fresh
 * confined resolution of the path by dev+inode — an intermediate directory
 * (or, on platforms without O_NOFOLLOW, the leaf itself) swapped for a
 * symlink after validation redirects the resolution to a different inode
 * and is refused. The content is streamed through the same fd into a
 * private staging slot carrying over only the requested basename, so the
 * CLI never re-opens the validated pathname and a post-validation swap of
 * the original cannot redirect the upload.
 *
 * `openFile` is injectable for adversarial tests only; production callers
 * use the default `fs.openSync`.
 */
export function stageUploadSource(
  inputPath: string,
  stagingDir: string,
  index: number,
  openFile: typeof fs.openSync = fs.openSync,
): string {
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

  // O_NOFOLLOW: resolved.path is canonical (no symlinks at validation
  // time), so a symlink at the leaf here can only be a post-validation
  // swap — refuse instead of following it outside the workspace.
  // O_NONBLOCK: opening a FIFO O_RDONLY would otherwise block until a
  // writer appears, letting a planted pipe wedge the connector; for
  // regular files O_NONBLOCK is a no-op. (Either flag is undefined on
  // platforms without it, where the composition degrades to a plain
  // O_RDONLY — the dev+inode re-resolution below still refuses a swap
  // there.)
  let inFd: number;
  try {
    inFd = openFile(
      resolved.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConnectorError(
        `File not found: ${inputPath}`,
        'PATH_OUTSIDE_WORKSPACE',
        'Pass file paths inside the workspace directory (MCP_WORKSPACE_PATH, or the system temp directory when unset).',
      );
    }
    if (
      code === 'ELOOP' || code === 'EMLINK' || code === 'EFTYPE' ||
      code === 'EISDIR' || code === 'EPERM' || code === 'EACCES'
    ) {
      // ELOOP/EMLINK/EFTYPE: the validated leaf was swapped for a symlink
      // before we could open it (the O_NOFOLLOW errno varies by platform).
      // EISDIR/EPERM/EACCES: swapped for a directory or an unreadable
      // object. Either way, refuse rather than read.
      throw uploadSourceChangedError(inputPath);
    }
    throw err;
  }
  try {
    const stat = fs.fstatSync(inFd);
    if (!stat.isFile()) {
      throw new ConnectorError(
        `file_path is not a regular file: ${inputPath}`,
        'NOT_A_REGULAR_FILE',
        'Pass a path to a regular file inside the workspace directory.',
      );
    }
    // An intermediate directory swapped for a symlink after validation
    // could have redirected the open itself (O_NOFOLLOW constrains only
    // the final component), so bind the descriptor to a fresh confined
    // resolution: the path must still resolve inside the workspace to the
    // SAME dev+inode we opened. Bytes are read through the fd below, so a
    // swap landing after this check cannot change the uploaded content.
    const recheck = resolveWorkspaceReadPath(inputPath);
    let fresh: fs.Stats | undefined;
    if (recheck.ok) {
      try {
        fresh = fs.statSync(recheck.path);
      } catch {
        fresh = undefined; // resolution failed — refuse below
      }
    }
    if (!fresh || fresh.dev !== stat.dev || fresh.ino !== stat.ino) {
      throw uploadSourceChangedError(inputPath);
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
    // unlinkSync, not rmSync: only a regular file or symlink may ever be
    // removed here. unlink refuses directories atomically in the kernel
    // (no lstat pre-check to race, as rmSync's ERR_FS_EISDIR path has) and
    // can never recurse — deleting a directory tree as a PDF-overwrite
    // side effect would be far worse than refusing.
    try {
      fs.unlinkSync(destPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EISDIR' || code === 'EPERM') {
        // EISDIR on Linux, EPERM on macOS: the destination is a directory.
        throw new ConnectorError(
          `Destination is a directory, not a file: ${destPath}`,
          'DESTINATION_IS_DIRECTORY',
          'Choose a file_path that does not collide with an existing directory.',
        );
      }
      if (code !== 'ENOENT') {
        throw err;
      }
      // ENOENT: nothing to overwrite — the exclusive-create below installs
      // the staged file.
    }
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
