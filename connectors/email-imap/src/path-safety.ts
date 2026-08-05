/**
 * Workspace-path containment for attachment downloads (AGENTS.md security
 * invariant #5). Downloaded attachments are written only inside the canonical
 * workspace root (`MCP_WORKSPACE_PATH`, else `os.tmpdir()`), under a fixed
 * `email-imap-attachments/` subdirectory, with attacker-controlled filenames
 * reduced to a sanitized basename. The root and subdirectory are canonicalised
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
 * Canonical workspace root for downloads: `MCP_WORKSPACE_PATH` when set and
 * non-empty, else `os.tmpdir()`. Canonicalised via `fs.realpathSync` so the
 * prefix check in `resolveDownloadPath` is stable on platforms where the
 * tmpdir itself is reached through a symlink; falls back to the lexically
 * resolved path when the root does not exist yet.
 */
export function getDownloadRoot(): string {
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
  const root = getDownloadRoot();
  const dir = path.join(root, DOWNLOAD_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  const canonicalDir = fs.realpathSync(dir);

  if (canonicalDir !== root && !canonicalDir.startsWith(root + path.sep)) {
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
