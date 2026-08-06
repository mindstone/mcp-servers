/**
 * path-safety adversarial tests — open-once outbound reads (fstat +
 * post-open identity re-verification, read-through-fd) and staged
 * exclusive-create downloads (fresh mkdtemp staging directory under the
 * canonical root: no-overwrite by construction, parent-directory swap
 * immunity, deterministic leaf-swap fault injection).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  describe('writeDownloadExclusive (staged exclusive-create downloads)', () => {
    it('writes the sanitized basename inside a fresh private staging directory under the canonical root', async () => {
      const dir = await resolveDownloadDir();
      const written = await writeDownloadExclusive(dir, '../../evil.pdf', Buffer.from('PDF'));

      const stagingDir = path.dirname(written);
      // The staging dir is a fresh, non-symlink mkdtemp child directly
      // under the canonical root; only the sanitized basename carries over.
      expect(path.dirname(stagingDir)).toBe(dir.root);
      expect(path.basename(stagingDir)).toMatch(/^email-imap-attachment-/);
      expect(path.basename(written)).toBe('evil.pdf');
      expect(fs.lstatSync(stagingDir).isSymbolicLink()).toBe(false);
      expect(fs.statSync(stagingDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(written).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(written, 'utf8')).toBe('PDF');
    });

    it('never clobbers a pre-existing same-named file anywhere in the workspace', async () => {
      const dir = await resolveDownloadDir();
      const sentinel = path.join(workspace, 'report.pdf');
      fs.writeFileSync(sentinel, 'ORIGINAL');

      const written = await writeDownloadExclusive(dir, 'report.pdf', Buffer.from('NEW'));
      expect(written).not.toBe(sentinel);
      expect(path.basename(written)).toBe('report.pdf');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('ORIGINAL');
      expect(fs.readFileSync(written, 'utf8')).toBe('NEW');
    });

    it('never writes through a pre-existing same-named symlink, inside or outside the workspace', async () => {
      const dir = await resolveDownloadDir();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-outside-'));
      const victim = path.join(outsideDir, 'victim.pdf');
      fs.writeFileSync(victim, 'VICTIM');
      // A symlink planted at a guessable path is simply never traversed:
      // the write stages under a fresh unpredictable directory name.
      fs.symlinkSync(victim, path.join(workspace, 'report.pdf'));

      const written = await writeDownloadExclusive(dir, 'report.pdf', Buffer.from('NEW'));
      expect(path.basename(written)).toBe('report.pdf');
      expect(fs.realpathSync(written).startsWith(dir.root + path.sep)).toBe(true);
      expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM');
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

    it('is immune to a parent-directory swap between validation and the write', async () => {
      // Adversarial regression: the directory the legacy write path used is
      // swapped for a symlink (pointing at an attacker-controlled dir outside
      // the workspace) after resolveDownloadDir has validated the root. The
      // write never traverses a validated user-visible pathname, so nothing
      // can be redirected through the swapped directory.
      const dir = await resolveDownloadDir();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-swap-out-'));
      const swappedDir = path.join(workspace, 'email-imap-attachments');
      fs.mkdirSync(swappedDir, { recursive: true });
      try {
        // Attacker swaps the formerly-validated directory for a symlink.
        fs.rmSync(swappedDir, { recursive: true });
        fs.symlinkSync(outsideDir, swappedDir);

        const written = await writeDownloadExclusive(dir, 'loot.pdf', Buffer.from('X'));

        // Nothing landed outside the workspace…
        expect(fs.readdirSync(outsideDir)).toEqual([]);
        // …and the bytes are only inside the fresh staging directory.
        expect(fs.readFileSync(written, 'utf8')).toBe('X');
        expect(path.dirname(path.dirname(written))).toBe(dir.root);
        expect(fs.realpathSync(written).startsWith(dir.root + path.sep)).toBe(true);
      } finally {
        // The symlink inside the workspace is removed by afterEach's
        // whole-workspace cleanup; the outside dir is ours to remove.
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('keeps every byte inside the workspace under a concurrent directory-swap storm', async () => {
      const dir = await resolveDownloadDir();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-race-out-'));
      const swapped = path.join(workspace, 'email-imap-attachments');
      const held = `${swapped}-held`;
      fs.mkdirSync(swapped, { recursive: true });
      // Victim that no write or cleanup may ever touch.
      const victimOutside = path.join(outsideDir, 'victim-do-not-delete.txt');
      fs.writeFileSync(victimOutside, 'precious');

      // Attacker loop: repeatedly replace a workspace subdirectory with a
      // symlink to the outside dir, then swap the real directory back.
      let swapping = true;
      const swapper = (async () => {
        while (swapping) {
          await fs.promises.rename(swapped, held).catch(() => {});
          await fs.promises.symlink(outsideDir, swapped).catch(() => {});
          await fs.promises.rm(swapped, { force: true }).catch(() => {});
          await fs.promises.rename(held, swapped).catch(() => {});
        }
      })();

      const saved: string[] = [];
      const content = Buffer.from('attachment bytes');
      try {
        for (let i = 0; i < 40; i += 1) {
          saved.push(await writeDownloadExclusive(dir, `probe-${i}.txt`, content));
        }
      } finally {
        swapping = false;
        await swapper;
      }

      // No connector bytes ever landed outside the workspace, and the
      // outside victim was never touched.
      expect(fs.readdirSync(outsideDir)).toEqual(['victim-do-not-delete.txt']);
      expect(fs.readFileSync(victimOutside, 'utf8')).toBe('precious');
      // Every reported success really holds the bytes at the reported path,
      // inside the canonical root.
      for (const p of saved) {
        expect(fs.realpathSync(p).startsWith(dir.root + path.sep)).toBe(true);
        expect(fs.readFileSync(p)).toEqual(content);
      }
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('refuses a leaf symlink planted between staging-dir creation and the open (fault injection)', async () => {
      // Deterministic race coverage: a synchronization hook on
      // fs.promises.open lets the "attacker" act in the exact window after
      // the staging directory is created but before the leaf is opened,
      // planting a symlink at the precise path the connector is about to
      // create. O_EXCL must refuse it — zero bytes written anywhere — and
      // the rejected write must leave no staging residue.
      const dir = await resolveDownloadDir();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-outside-'));
      const victim = path.join(outsideDir, 'victim.pdf');
      fs.writeFileSync(victim, 'VICTIM');

      const realOpen = fs.promises.open;
      let injected = false;
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
        target: fs.PathLike | fs.promises.FileHandle,
        flags?: string | number,
        mode?: fs.Mode,
      ) => {
        if (!injected && typeof target === 'string') {
          injected = true;
          fs.symlinkSync(victim, target);
        }
        return realOpen(target as fs.PathLike, flags as string, mode);
      }) as typeof fs.promises.open);

      try {
        await expect(
          writeDownloadExclusive(dir, 'report.pdf', Buffer.from('NEW')),
        ).rejects.toThrow(/EEXIST/);
        expect(injected).toBe(true);
      } finally {
        spy.mockRestore();
      }

      // Zero bytes written: the symlink target is untouched…
      expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM');
      // …and the failed write cleaned its whole staging directory up.
      expect(fs.readdirSync(dir.root)).toEqual([]);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('fails closed when the workspace root does not exist, writing nothing', async () => {
      const missing = path.join(workspace, 'does-not-exist');
      process.env.MCP_WORKSPACE_PATH = missing;
      await expect(resolveDownloadDir()).rejects.toThrow();
      expect(fs.existsSync(missing)).toBe(false);
    });
  });
});
