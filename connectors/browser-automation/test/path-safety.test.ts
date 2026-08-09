import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createStagingDir,
  discardStagingDir,
  installStagedFile,
  stageUploadSource,
} from '../src/path-safety.js';
import { ConnectorError } from '../src/types.js';

describe('stageUploadSource — post-validation swap races', () => {
  let workspace: string;
  let stagingDir: string | undefined;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-path-safety-')));
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  });

  afterEach(() => {
    if (stagingDir) discardStagingDir(stagingDir);
    stagingDir = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('refuses a leaf swapped for an escaping symlink between validation and open', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-outside-'));
    try {
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'outside-secret');
      fs.writeFileSync(path.join(workspace, 'report.pdf'), 'workspace-bytes');
      stagingDir = createStagingDir('browser-upload-');

      // Simulate the attacker winning the validation→open race: the
      // validated leaf is replaced by a symlink escaping the workspace just
      // before the open. With O_NOFOLLOW the open itself fails (ELOOP);
      // without it the dev+inode re-resolution refuses the opened outside
      // file. Either way the refusal is UPLOAD_SOURCE_CHANGED.
      const swapBeforeOpen = ((p: fs.PathLike, flags: number, mode?: number) => {
        fs.rmSync(p as string, { force: true });
        fs.symlinkSync(outsideFile, p as string);
        return fs.openSync(p, flags, mode);
      }) as typeof fs.openSync;

      let caught: unknown;
      try {
        stageUploadSource('report.pdf', stagingDir, 0, swapBeforeOpen);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConnectorError);
      expect((caught as ConnectorError).code).toBe('UPLOAD_SOURCE_CHANGED');
      // Nothing staged: the outside bytes must not reach the upload slot.
      expect(fs.readdirSync(path.join(stagingDir, '0'))).toEqual([]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses when the file is replaced (new inode) after open', () => {
    fs.writeFileSync(path.join(workspace, 'report.pdf'), 'workspace-bytes');
    stagingDir = createStagingDir('browser-upload-');

    const replaceAfterOpen = ((p: fs.PathLike, flags: number, mode?: number) => {
      const fd = fs.openSync(p, flags, mode);
      // Attacker replaces the validated file with different content in the
      // open→read window; the fd still points at the old inode while the
      // path now resolves to a new one.
      fs.rmSync(p as string, { force: true });
      fs.writeFileSync(p as string, 'REPLACED CONTENT');
      return fd;
    }) as typeof fs.openSync;

    let caught: unknown;
    try {
      stageUploadSource('report.pdf', stagingDir, 0, replaceAfterOpen);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect((caught as ConnectorError).code).toBe('UPLOAD_SOURCE_CHANGED');
  });

  it('refuses when an intermediate directory is swapped for an escaping symlink before open', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-outside-'));
    try {
      const reportsDir = path.join(workspace, 'reports');
      fs.mkdirSync(reportsDir);
      fs.writeFileSync(path.join(reportsDir, 'report.pdf'), 'workspace-bytes');
      fs.writeFileSync(path.join(outsideDir, 'report.pdf'), 'outside-secret');
      stagingDir = createStagingDir('browser-upload-');

      // O_NOFOLLOW constrains only the final component; an ancestor swap
      // redirects the open through the symlinked directory. The dev+inode
      // re-resolution must refuse it.
      const swapAncestorBeforeOpen = ((p: fs.PathLike, flags: number, mode?: number) => {
        fs.rmSync(reportsDir, { recursive: true, force: true });
        fs.symlinkSync(outsideDir, reportsDir);
        return fs.openSync(p, flags, mode);
      }) as typeof fs.openSync;

      let caught: unknown;
      try {
        stageUploadSource('reports/report.pdf', stagingDir, 0, swapAncestorBeforeOpen);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConnectorError);
      expect((caught as ConnectorError).code).toBe('UPLOAD_SOURCE_CHANGED');
      expect(fs.readdirSync(path.join(stagingDir, '0'))).toEqual([]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking on the open', () => {
    execFileSync('mkfifo', [path.join(workspace, 'pipe.fifo')]);
    stagingDir = createStagingDir('browser-upload-');

    let caught: unknown;
    try {
      stageUploadSource('pipe.fifo', stagingDir, 0);
    } catch (err) {
      caught = err;
    }

    // O_NONBLOCK lets the open return immediately and the fstat check then
    // refuses the FIFO — without it this open would block until a writer
    // appears, wedging the connector (this test would time out instead).
    expect(caught).toBeInstanceOf(ConnectorError);
    expect((caught as ConnectorError).code).toBe('NOT_A_REGULAR_FILE');
  });
});

describe('installStagedFile — overwrite onto a directory', () => {
  let workspace: string;
  let stagingDir: string | undefined;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-path-safety-')));
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  });

  afterEach(() => {
    if (stagingDir) discardStagingDir(stagingDir);
    stagingDir = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('refuses with DESTINATION_IS_DIRECTORY instead of a raw filesystem error', () => {
    const destDir = path.join(workspace, 'page.pdf');
    fs.mkdirSync(destDir);
    fs.writeFileSync(path.join(destDir, 'keep.txt'), 'keep');
    stagingDir = createStagingDir('browser-pdf-');
    const stagingPath = path.join(stagingDir, 'page.pdf');
    fs.writeFileSync(stagingPath, 'pdf-bytes');

    let caught: unknown;
    try {
      installStagedFile(
        {
          destPath: destDir,
          canonicalParentDir: fs.realpathSync(workspace),
          stagingPath,
          stagingDir,
        },
        true,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect((caught as ConnectorError).code).toBe('DESTINATION_IS_DIRECTORY');
    // The directory and its contents are untouched — the delete is a bare
    // unlink and can never recurse.
    expect(fs.readFileSync(path.join(destDir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('installs when the destination vanished before the overwrite delete', () => {
    const destPath = path.join(workspace, 'page.pdf');
    stagingDir = createStagingDir('browser-pdf-');
    const stagingPath = path.join(stagingDir, 'page.pdf');
    fs.writeFileSync(stagingPath, 'pdf-bytes');

    // ENOENT on the overwrite delete is not an error — nothing to replace.
    installStagedFile(
      {
        destPath,
        canonicalParentDir: fs.realpathSync(workspace),
        stagingPath,
        stagingDir,
      },
      true,
    );

    expect(fs.readFileSync(destPath, 'utf8')).toBe('pdf-bytes');
  });
});
