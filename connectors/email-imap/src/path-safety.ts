/**
 * Workspace-path containment for attachment file I/O (AGENTS.md security
 * invariant #5). Downloaded attachments are written only inside the canonical
 * workspace root (`MCP_WORKSPACE_PATH`, else `os.tmpdir()`), under a fixed
 * `email-imap-attachments/` subdirectory, with attacker-controlled filenames
 * reduced to a sanitized basename; outbound attachment reads are likewise
 * confined to the workspace root. The root and candidates are canonicalised
 * through `fs.realpathSync` so a symlinked root (e.g. macOS /tmp →
 * /private/tmp) cannot confuse the prefix check, and containment is verified
 * with a canonical prefix comparison — never substring checks on
 * non-canonical paths.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DOWNLOAD_SUBDIR = 'email-imap-attachments';

/**
 * Canonical workspace root for attachment file I/O: `MCP_WORKSPACE_PATH`
 * when set and non-empty, else `os.tmpdir()`. Canonicalised via
 * `fs.realpathSync` so prefix checks are stable on platforms where the
 * tmpdir itself is reached through a symlink; falls back to the lexically
 * resolved path when the root does not exist yet.
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
 * the leaf file to exist.
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

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Validate that `inputPath` resolves to a real file inside the workspace
 * root, even after symlink resolution, and return its canonical path.
 * Throws with an actionable message otherwise. Used for OUTBOUND attachment
 * reads (email_send / email_save_draft / email_update_draft): a path outside
 * the sandbox must never leave the process as email content.
 *
 *  - `~` is expanded to `os.homedir()` lexically; the expanded path must
 *    still resolve inside the workspace root.
 *  - `path.resolve` collapses `..` segments; lexical escapes are rejected
 *    before any disk access.
 *  - `fs.realpathSync` canonicalises the file so a symlink inside the root
 *    pointing OUTSIDE the root is refused.
 */
export function resolveReadPath(inputPath: string): string {
  const root = getWorkspaceRoot();

  const expanded = inputPath.startsWith('~')
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  const lexical = path.resolve(expanded);

  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(root, canonicalCandidate)) {
    throw new Error(
      `Attachment path is outside the workspace sandbox root (${root}). Got: ${inputPath}`,
    );
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Attachment file not found: ${inputPath}`);
    }
    throw err;
  }

  if (!isInsideRoot(root, canonical)) {
    throw new Error(
      `Attachment path resolves outside the workspace sandbox root (${root}); ` +
        `symlinks may not escape the workspace. Got: ${inputPath}`,
    );
  }

  if (!fs.statSync(canonical).isFile()) {
    throw new Error(`Attachment path is not a file: ${inputPath}`);
  }

  return canonical;
}

/**
 * Reduce an attacker-controlled attachment filename to a safe basename:
 * strips directory components (both `/` and `\` separators), control
 * characters, and leading dots (no hidden files), falling back to
 * 'attachment' when nothing usable remains.
 */
export function sanitizeAttachmentFilename(name: string | null | undefined): string {
  const base = path
    .basename((name ?? '').replace(/\\/g, '/'))
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return base.length > 0 ? base : 'attachment';
}

/**
 * Resolve the download target for `filename` inside the canonical workspace
 * root, creating the `email-imap-attachments/` subdirectory if needed.
 * Containment holds by construction (fixed subdir + sanitized basename) and
 * is re-verified against the canonical root so a symlinked subdirectory
 * pointing outside the workspace is refused. Existing files are not
 * overwritten: a numeric timestamp suffix is appended on collision.
 */
export function resolveDownloadPath(filename: string | null | undefined): string {
  const root = getWorkspaceRoot();
  const dir = path.join(root, DOWNLOAD_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  const canonicalDir = fs.realpathSync(dir);

  if (!isInsideRoot(root, canonicalDir)) {
    throw new Error(
      `Attachment download directory escapes the workspace sandbox root (${root}): ${canonicalDir}`,
    );
  }

  const safeName = sanitizeAttachmentFilename(filename);
  let candidate = path.join(canonicalDir, safeName);
  if (fs.existsSync(candidate)) {
    const ext = path.extname(safeName);
    const stem = safeName.slice(0, safeName.length - ext.length);
    candidate = path.join(canonicalDir, `${stem}-${Date.now()}${ext}`);
  }
  return candidate;
}
