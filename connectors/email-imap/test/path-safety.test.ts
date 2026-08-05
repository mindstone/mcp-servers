/**
 * path-safety adversarial tests — open-once outbound reads (fstat +
 * post-open identity re-verification, read-through-fd) and atomic
 * exclusive-create downloads (no overwrite, collision retry, parent-dir
 * swap detection).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readWorkspaceAttachment,
  resolveDownloadDir,
  writeDownloadExclusive,
} from '../src/path-safety.js';

describe('path-safety', () => {
  let workspace: string;
  let savedWorkspaceEnv: string | undefined;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-pathsafety-'));
    savedWorkspaceEnv = process.env.MCP_WORKSPACE_PATH;
    process.env.MCP_WORKSPACE_PATH = workspace;
  });

  afterEach(() => {
    if (savedWorkspaceEnv === undefined) {
      delete process.env.MCP_WORKSPACE_PATH;
    } else {
      process.env.MCP_WORKSPACE_PATH = savedWorkspaceEnv;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  describe('readWorkspaceAttachment (open-once outbound reads)', () => {
    it('reads an in-workspace file through the validated descriptor', () => {
      const filePath = path.join(workspace, 'note.txt');
      fs.writeFileSync(filePath, 'hello attachment');

      const read = readWorkspaceAttachment(filePath);
      expect(read.content.equals(Buffer.from('hello attachment'))).toBe(true);
      expect(read.sizeBytes).toBe(Buffer.byteLength('hello attachment'));
      expect(read.canonicalPath).toBe(fs.realpathSync(filePath));
    });

    it('reads via an in-workspace symlink whose target stays inside the sandbox', () => {
      const realFile = path.join(workspace, 'real.txt');
      fs.writeFileSync(realFile, 'via symlink');
      const linkPath = path.join(workspace, 'link.txt');
      fs.symlinkSync(realFile, linkPath);

      const read = readWorkspaceAttachment(linkPath);
      expect(read.content.toString('utf8')).toBe('via symlink');
    });

    it('refuses a path outside the workspace', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'top secret');
      expect(
        fs.realpathSync(outsideFile).startsWith(fs.realpathSync(workspace) + path.sep),
      ).toBe(false);

      expect(() => readWorkspaceAttachment(outsideFile)).toThrow(/workspace sandbox/);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('refuses an in-workspace symlink that points outside the sandbox', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'top secret');
      const linkPath = path.join(workspace, 'escape.txt');
      fs.symlinkSync(outsideFile, linkPath);

      expect(() => readWorkspaceAttachment(linkPath)).toThrow(/workspace sandbox/);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('refuses a directory (fstat isFile on the opened descriptor)', () => {
      expect(() => readWorkspaceAttachment(workspace)).toThrow(/not a file/);
    });

    it('refuses a missing file', () => {
      expect(() => readWorkspaceAttachment(path.join(workspace, 'nope.txt'))).toThrow(
        /not found/,
      );
    });

    it('refuses a symlink swapped in between validation passes', () => {
      // First call validates a genuine file. Then replace it with a symlink
      // to an outside file and confirm the second call refuses — the
      // post-open canonical re-resolution must catch the escape every time,
      // not just on a cached first validation.
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'top secret');

      const target = path.join(workspace, 'swap.txt');
      fs.writeFileSync(target, 'original');
      expect(readWorkspaceAttachment(target).content.toString('utf8')).toBe('original');

      fs.rmSync(target);
      fs.symlinkSync(outsideFile, target);
      expect(() => readWorkspaceAttachment(target)).toThrow(/workspace sandbox/);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });
  });

  describe('writeDownloadExclusive (atomic no-overwrite downloads)', () => {
    it('creates the file with the sanitized basename', async () => {
      const dir = await resolveDownloadDir();
      const written = await writeDownloadExclusive(dir, '../../evil.pdf', Buffer.from('PDF'));
      expect(path.basename(written)).toBe('evil.pdf');
      expect(written.startsWith(dir.dir + path.sep)).toBe(true);
      expect(fs.readFileSync(written, 'utf8')).toBe('PDF');
    });

    it('never overwrites an existing file; retries with a numeric suffix', async () => {
      const dir = await resolveDownloadDir();
      const first = path.join(dir.dir, 'report.pdf');
      fs.writeFileSync(first, 'ORIGINAL');

      const second = await writeDownloadExclusive(dir, 'report.pdf', Buffer.from('NEW'));
      expect(path.basename(second)).toBe('report-1.pdf');
      expect(fs.readFileSync(first, 'utf8')).toBe('ORIGINAL');
      expect(fs.readFileSync(second, 'utf8')).toBe('NEW');
    });

    it('refuses to follow a pre-planted symlink at the target name', async () => {
      const dir = await resolveDownloadDir();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-outside-'));
      const outsideFile = path.join(outsideDir, 'victim.pdf');
      fs.writeFileSync(outsideFile, 'VICTIM');
      // Attacker plants a symlink at the exact chosen download name,
      // pointing at an out-of-workspace victim file.
      fs.symlinkSync(outsideFile, path.join(dir.dir, 'report.pdf'));

      const written = await writeDownloadExclusive(dir, 'report.pdf', Buffer.from('NEW'));
      // O_EXCL refuses the symlinked name, so the write lands on a suffix
      // and the victim is untouched.
      expect(path.basename(written)).toBe('report-1.pdf');
      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('VICTIM');
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('gives concurrent same-name downloads distinct paths, losing no bytes', async () => {
      const dir = await resolveDownloadDir();
      const writes = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          writeDownloadExclusive(dir, 'same.pdf', Buffer.from(`payload-${i}`)),
        ),
      );
      const unique = new Set(writes);
      expect(unique.size).toBe(5);
      const bodies = writes
        .map((p) => fs.readFileSync(p, 'utf8'))
        .sort();
      expect(bodies).toEqual([
        'payload-0',
        'payload-1',
        'payload-2',
        'payload-3',
        'payload-4',
      ]);
    });

    it('fails closed when the download directory is swapped for a symlink after validation', async () => {
      const dir = await resolveDownloadDir();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-outside-'));

      // Rename-and-replace: the validated directory is moved aside and a
      // symlink to an outside directory takes its place. The pinned dev/ino
      // identity no longer matches, so the write must refuse — and must not
      // leave bytes outside the workspace.
      const movedAside = `${dir.dir}-aside`;
      fs.renameSync(dir.dir, movedAside);
      fs.symlinkSync(outsideDir, dir.dir);

      await expect(
        writeDownloadExclusive(dir, 'loot.pdf', Buffer.from('X')),
      ).rejects.toThrow(/replaced after validation|escape/i);
      expect(fs.readdirSync(outsideDir)).toEqual([]);

      fs.rmSync(movedAside, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });
  });
});
