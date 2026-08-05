import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OpusError } from './types.js';

/**
 * Workspace sandbox for local-file reads (opus_upload_video) and writes
 * (opus_download_clip) — AGENTS.md security invariant #5.
 *
 * Both operations are constrained to `MCP_WORKSPACE_PATH` when set, falling
 * back to `os.tmpdir()`. The root is canonicalised through `fs.realpathSync`
 * so the prefix checks below are stable on platforms where the system tmpdir
 * is itself reached through a symlink (e.g. macOS: /var/folders/... →
 * /private/var/folders/...). If the root cannot be canonicalised (e.g. the
 * env var points at a non-existent directory) the lexical path is used so
 * the containment check still produces a clean refusal.
 */
export function getWorkspaceRoot(): string {
  const envRoot = process.env.MCP_WORKSPACE_PATH;
  const raw = envRoot && envRoot.trim() ? envRoot.trim() : os.tmpdir();
  const lexical = path.resolve(raw);
  try {
    return fs.realpathSync(lexical);
  } catch {
    return lexical;
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Canonicalise the deepest existing ancestor of an absolute path and
 * re-append the missing tail. This lets the containment check accept
 * in-workspace paths supplied via a symlinked alias of the workspace root
 * (e.g. `/tmp` → `/private/tmp` on macOS) while still rejecting `..`
 * traversal and out-of-root absolutes deterministically, without requiring
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

/**
 * Resolve an LLM-supplied upload source path to a real, readable file inside
 * the workspace sandbox. Throws a structured `OpusError` on any refusal:
 *  - lexical `..` traversal or an absolute path outside the root,
 *  - a symlink inside the root that points outside it (full realpath check),
 *  - a missing file.
 */
export function resolveUploadSourcePath(input: string): string {
  const root = getWorkspaceRoot();
  const denyResolution =
    `Move the video into the workspace root (${root}) and pass that path. ` +
    'Reads are confined to MCP_WORKSPACE_PATH (or the system temp directory when it is unset).';

  const expanded = input.startsWith('~') ? path.join(os.homedir(), input.slice(1)) : input;
  const lexical = path.resolve(expanded);

  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(canonicalCandidate, root)) {
    throw new OpusError(
      `file_path is outside the workspace sandbox root (${root}): ${input}`,
      'PATH_OUTSIDE_WORKSPACE',
      denyResolution,
    );
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OpusError(
        `File not found: ${input}`,
        'VALIDATION_ERROR',
        'Pass an absolute path to an existing local video file inside the workspace.',
      );
    }
    throw err;
  }

  if (!isInsideRoot(canonical, root)) {
    throw new OpusError(
      `file_path resolves outside the workspace sandbox root (${root}) — symlinks may not escape the workspace: ${input}`,
      'PATH_OUTSIDE_WORKSPACE',
      denyResolution,
    );
  }

  return canonical;
}

/**
 * Resolve an LLM-supplied download target to a writable path inside the
 * workspace sandbox:
 *  1. Lexical containment catches `..` traversal regardless of fs state.
 *  2. The parent dir must realpath into the same root (catches a symlinked
 *     directory inside the root pointing outside it).
 *  3. An existing symlink at the target itself is refused (never written
 *     through, even with `overwrite: true`).
 *
 * Returns the canonical write target on success; throws `OpusError` on any
 * refusal.
 */
export function resolveDownloadTargetPath(input: string): string {
  const root = getWorkspaceRoot();
  const denyResolution =
    `Pick an output_path inside the workspace root (${root}). ` +
    'Downloads are confined to MCP_WORKSPACE_PATH (or the system temp directory when it is unset).';

  const lexical = path.resolve(input);

  if (!isInsideRoot(lexical, root) && !isInsideRoot(canonicalisePrefix(lexical), root)) {
    throw new OpusError(
      `output_path is outside the workspace sandbox root (${root}): ${input}`,
      'PATH_OUTSIDE_WORKSPACE',
      denyResolution,
    );
  }

  const lexicalParent = path.dirname(lexical);
  let realParent: string;
  try {
    realParent = fs.realpathSync(lexicalParent);
  } catch {
    throw new OpusError(
      `Parent directory does not exist or is not accessible: ${lexicalParent}`,
      'OUTPUT_PARENT_NOT_FOUND',
      `Create ${lexicalParent} first, or pick an output_path inside ${root}.`,
    );
  }
  if (!isInsideRoot(realParent, root)) {
    throw new OpusError(
      `output_path is outside the workspace sandbox root (${root}): ${input}`,
      'PATH_OUTSIDE_WORKSPACE',
      denyResolution,
    );
  }

  const resolved = path.join(realParent, path.basename(lexical));

  try {
    const lst = fs.lstatSync(resolved);
    if (lst.isSymbolicLink()) {
      throw new OpusError(
        `output_path already exists as a symbolic link, refusing to write through it: ${input}`,
        'OUTPUT_PATH_IS_SYMLINK',
        'Remove or rename the existing symlink before retrying. Downloads never write through a symlink at the target, even with overwrite=true.',
      );
    }
    if (!lst.isFile()) {
      throw new OpusError(
        `output_path already exists and is not a regular file: ${input}`,
        'OUTPUT_PATH_NOT_REGULAR_FILE',
        'Remove or rename the existing target, or pick a different output_path.',
      );
    }
  } catch (err) {
    if (err instanceof OpusError) throw err;
    // ENOENT (target does not exist yet) is the happy path — the caller's
    // `wx`/`w` open flag governs create-vs-clobber.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return resolved;
}
