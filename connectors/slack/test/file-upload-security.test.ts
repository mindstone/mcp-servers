/**
 * Adversarial upload-path tests: the upload source read must be a single
 * race-resistant operation (open-once, fstat the descriptor, read through the
 * descriptor), and the upload-bytes POST must re-validate every redirect hop
 * before re-sending the local file.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readUploadSourceFile } from '../src/upload-path-safety.js';
import { postSlackFileToUploadUrl } from '../src/tools/files.js';

const ONE_KIB = 1024;

describe('postSlackFileToUploadUrl — redirect discipline', () => {
  function buildResponse(init: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  }): Response {
    return new Response(init.body ?? '', {
      status: init.status ?? 200,
      headers: init.headers ?? {},
    });
  }

  it('follows a Slack-to-Slack redirect and re-sends the body to the new Slack host', async () => {
    const calls: Array<{ url: string; bodyBytes: number }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls.push({ url: u, bodyBytes: (init?.body as Uint8Array)?.byteLength ?? 0 });
      if (u.endsWith('/first')) {
        return buildResponse({
          status: 307,
          headers: { location: 'https://files-uploads.slack.com/second' },
        });
      }
      return buildResponse({ status: 200, body: 'OK' });
    });

    const res = await postSlackFileToUploadUrl(
      'https://files.slack.com/first',
      Buffer.from('payload'),
      fetchMock as unknown as typeof fetch,
      new AbortController().signal,
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://files-uploads.slack.com/second');
    // The local file bytes were re-sent to the re-validated Slack host.
    expect(calls[1]?.bodyBytes).toBe('payload'.length);
  });

  it('refuses a Slack-to-evil redirect BEFORE re-sending the local file bytes', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls.push(u);
      if (u.includes('slack.com')) {
        return buildResponse({
          status: 302,
          headers: { location: 'https://attacker.example/collect' },
        });
      }
      return buildResponse({ status: 200, body: 'exfiltrated' });
    });

    await expect(
      postSlackFileToUploadUrl(
        'https://files.slack.com/upload/v1/ABC',
        Buffer.from('local file contents'),
        fetchMock as unknown as typeof fetch,
        new AbortController().signal,
      ),
    ).rejects.toThrowError(/SLACK_FILE_URL_UNTRUSTED|slack/i);

    // Only the original Slack URL received the bytes.
    expect(calls).toEqual(['https://files.slack.com/upload/v1/ABC']);
  });

  it('refuses a redirect chain longer than the configured maximum', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      const hop = Number.parseInt(/hop-(\d+)/.exec(u)?.[1] ?? '0', 10);
      return buildResponse({
        status: 302,
        headers: { location: `https://files.slack.com/loop/hop-${hop + 1}` },
      });
    });

    await expect(
      postSlackFileToUploadUrl(
        'https://files.slack.com/loop/hop-0',
        Buffer.from('x'),
        fetchMock as unknown as typeof fetch,
        new AbortController().signal,
      ),
    ).rejects.toThrowError(/redirect chain exceeded/);
  });
});

describe('readUploadSourceFile — race-resistant confined read', () => {
  let workspaceDir: string;
  let workspaceFile: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-upload-race-'));
    workspaceFile = path.join(workspaceDir, 'report.txt');
    fs.writeFileSync(workspaceFile, 'quarterly report contents');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('reads a regular in-workspace file', async () => {
    const result = await readUploadSourceFile(workspaceFile, ONE_KIB);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.buffer.toString('utf8')).toBe('quarterly report contents');
      expect(result.size).toBe('quarterly report contents'.length);
    }
  });

  it('accepts a file at exactly the size cap and refuses one byte over', async () => {
    const exact = path.join(workspaceDir, 'exact.bin');
    const over = path.join(workspaceDir, 'over.bin');
    fs.writeFileSync(exact, Buffer.alloc(ONE_KIB, 1));
    fs.writeFileSync(over, Buffer.alloc(ONE_KIB + 1, 1));

    const atCap = await readUploadSourceFile(exact, ONE_KIB);
    expect(atCap.ok).toBe(true);

    const overCap = await readUploadSourceFile(over, ONE_KIB);
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.error).toContain('File too large');
  });

  it('refuses a file that grows past the cap after validation', async () => {
    // The fd-bounded read enforces the cap on bytes actually read, so an
    // append after fstat cannot bypass it.
    const growable = path.join(workspaceDir, 'grow.bin');
    fs.writeFileSync(growable, Buffer.alloc(ONE_KIB - 8, 1));
    const openThatAppends: typeof fs.promises.open = (async (
      p: fs.PathLike,
      flags?: string | number,
    ) => {
      const handle = await fs.promises.open(p, flags);
      fs.appendFileSync(growable, Buffer.alloc(64, 2));
      return handle;
    }) as typeof fs.promises.open;

    const result = await readUploadSourceFile(growable, ONE_KIB, openThatAppends);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('File too large');
  });

  it('refuses a directory', async () => {
    const result = await readUploadSourceFile(workspaceDir, ONE_KIB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not a regular file');
  });

  it('refuses a FIFO (non-regular special file)', async (context) => {
    let fifoMade = true;
    const fifo = path.join(workspaceDir, 'pipe.fifo');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      fifoMade = false;
    }
    if (!fifoMade) {
      context.skip();
      return;
    }
    const result = await readUploadSourceFile(fifo, ONE_KIB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not a regular file');
  });

  it('refuses when the validated leaf is swapped for a symlink before open', async () => {
    const outside = path.join(os.tmpdir(), `slack-race-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'outside secret');
    const swapToSymlink: typeof fs.promises.open = (async (
      p: fs.PathLike,
      flags?: string | number,
    ) => {
      // Attacker replaces the validated file with an escaping symlink in the
      // validation→open window. O_NOFOLLOW must turn this into a refusal.
      fs.rmSync(p as string, { force: true });
      fs.symlinkSync(outside, p as string);
      return fs.promises.open(p, flags);
    }) as typeof fs.promises.open;

    try {
      const result = await readUploadSourceFile(workspaceFile, ONE_KIB, swapToSymlink);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('changed between validation and read');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('refuses when the file is replaced (new inode) after open', async () => {
    const replaceAfterOpen: typeof fs.promises.open = (async (
      p: fs.PathLike,
      flags?: string | number,
    ) => {
      const handle = await fs.promises.open(p, flags);
      // Replacement, not truncation: the path now names a different inode.
      fs.rmSync(p as string, { force: true });
      fs.writeFileSync(p as string, 'REPLACED CONTENT');
      return handle;
    }) as typeof fs.promises.open;

    const result = await readUploadSourceFile(workspaceFile, ONE_KIB, replaceAfterOpen);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('replaced');
  });

  it('refuses when an ancestor directory is swapped for an escaping symlink before open', async () => {
    const subdir = path.join(workspaceDir, 'sub');
    fs.mkdirSync(subdir);
    const innerFile = path.join(subdir, 'inner.txt');
    fs.writeFileSync(innerFile, 'inner contents');

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-race-ancestor-'));
    fs.writeFileSync(path.join(outsideDir, 'inner.txt'), 'outside secret');

    const swapAncestor: typeof fs.promises.open = (async (
      p: fs.PathLike,
      flags?: string | number,
    ) => {
      // The validated path's parent is swapped for a symlink out of the
      // workspace in the validation→open window.
      fs.rmSync(subdir, { recursive: true, force: true });
      fs.symlinkSync(outsideDir, subdir);
      return fs.promises.open(p, flags);
    }) as typeof fs.promises.open;

    try {
      const result = await readUploadSourceFile(innerFile, ONE_KIB, swapAncestor);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('outside the workspace root');
    } finally {
      fs.rmSync(subdir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('reads the originally-opened inode even if the path content changes after open', async () => {
    // Same-inode append keeps dev/ino identical, so the re-verify passes —
    // and the read still comes through the descriptor, not a re-opened path.
    const appendAfterOpen: typeof fs.promises.open = (async (
      p: fs.PathLike,
      flags?: string | number,
    ) => {
      const handle = await fs.promises.open(p, flags);
      fs.appendFileSync(workspaceFile, ' [appended]');
      return handle;
    }) as typeof fs.promises.open;

    const result = await readUploadSourceFile(workspaceFile, ONE_KIB, appendAfterOpen);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.buffer.toString('utf8')).toContain('quarterly report contents');
    }
  });

  it('still refuses a static escaping symlink', async () => {
    const outside = path.join(os.tmpdir(), `slack-race-static-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'secret');
    const link = path.join(workspaceDir, 'escape.txt');
    fs.symlinkSync(outside, link);
    try {
      const result = await readUploadSourceFile(link, ONE_KIB);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('outside the workspace root');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
