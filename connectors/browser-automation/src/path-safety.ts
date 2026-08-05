import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
 *     directory), fall back to the lexically-resolved path so the
 *     containment checks still produce a clean refusal.
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
