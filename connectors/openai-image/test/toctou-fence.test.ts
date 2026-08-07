import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryClientPair,
  importConnectorModule,
  makeImageBase64,
} from './helpers.js';

const cleanupTargets: string[] = [];
const IMAGE_BASE64 = makeImageBase64('png');

// ESM module namespaces are not configurable, so vi.spyOn cannot intercept
// fs.realpathSync — which the connector's deliberately-synchronous post-open
// realpath→lstat pair uses. Intercept at the module boundary instead: a test
// pushes a hook that fires synchronously right after a matching realpathSync
// call, reproducing the exact realpath→lstat window the swap-back and
// directory-swap races target. Everything else passes through untouched.
const { realpathSyncHooks } = vi.hoisted(() => ({
  realpathSyncHooks: [] as Array<{ targetPath: string; fire: () => void }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realpathSync = ((target: fs.PathLike, ...rest: unknown[]) => {
    const result = (actual.realpathSync as (...args: unknown[]) => unknown)(
      target,
      ...rest,
    );
    for (let i = realpathSyncHooks.length - 1; i >= 0; i -= 1) {
      const hook = realpathSyncHooks[i];
      if (hook && String(target) === hook.targetPath) {
        realpathSyncHooks.splice(i, 1);
        hook.fire();
      }
    }
    return result;
  }) as typeof fs.realpathSync;
  return { ...actual, realpathSync, default: actual.default };
});

// realpath-normalised: on macOS /tmp is a symlink to /private/tmp, and the
// connector's fence resolves the canonical path, so mocks keyed on the input
// path only fire when the setup paths are canonical too.
const makeTempDir = async (label: string): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join('/tmp', `Acme-${label}-`));
  const canonicalDir = await fsp.realpath(dir);
  cleanupTargets.push(canonicalDir);
  return canonicalDir;
};

const mockOpenAIImageResponses = (): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(
      JSON.stringify({ data: [{ b64_json: IMAGE_BASE64 }] }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

const extractErrorPayload = (
  result: CallToolResult,
): { ok: boolean; code?: string; error?: string } => {
  expect(result.isError).toBe(true);
  const text = result.content.find(
    (block): block is { type: 'text'; text: string } => block.type === 'text',
  );
  if (!text) {
    throw new Error('Expected a text error payload.');
  }
  return JSON.parse(text.text) as { ok: boolean; code?: string };
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  realpathSyncHooks.length = 0;
  while (cleanupTargets.length > 0) {
    const target = cleanupTargets.pop();
    if (target) {
      await fsp.rm(target, { recursive: true, force: true });
    }
  }
});

describe('edit-image file loading is open-then-validate (MED-1)', () => {
  it('reads a legitimate workspace image through the descriptor path', async () => {
    const workspace = await makeTempDir('toctou-happy');
    const sourcePath = path.join(workspace, 'source.png');
    await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-toctou-happy',
    });
    const fetchSpy = mockOpenAIImageResponses();
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme recolor',
          image_paths: [sourcePath],
          quality: 'medium',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await pair.close();
    }
  });

  it('reads through an in-workspace symlink (same inode as the fence-validated target)', async () => {
    const workspace = await makeTempDir('toctou-symlink');
    const targetPath = path.join(workspace, 'real.png');
    const linkPath = path.join(workspace, 'linked.png');
    await fsp.writeFile(targetPath, Buffer.alloc(256, 7));
    await fsp.symlink(targetPath, linkPath);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-toctou-symlink',
    });
    const fetchSpy = mockOpenAIImageResponses();
    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme recolor',
          image_paths: [linkPath],
          quality: 'medium',
        },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await pair.close();
    }
  });

  it('rejects when the file opened is not the inode the fence validated', async () => {
    const workspace = await makeTempDir('toctou-swap');
    const sourcePath = path.join(workspace, 'source.png');
    const impostorPath = path.join(workspace, 'impostor.png');
    await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));
    await fsp.writeFile(impostorPath, Buffer.alloc(256, 9));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-toctou-swap',
    });
    const fetchSpy = mockOpenAIImageResponses();

    // Simulate a local race: the path is swapped between the fence's realpath
    // validation and the open, so the descriptor points at a different inode.
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((
      _target: fs.PathLike,
      flags?: fs.OpenMode,
      mode?: fs.Mode,
    ) => realOpen(impostorPath, flags, mode)) as typeof fs.promises.open);

    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme recolor',
          image_paths: [sourcePath],
          quality: 'medium',
        },
      })) as CallToolResult;

      const payload = extractErrorPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('WORKSPACE_FENCE_VIOLATION');
      expect(payload.error).toContain('changed while it was being verified');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await pair.close();
    }
  });

  it('rejects when the real pathname is swapped for an out-of-fence symlink between fence and read', async () => {
    const workspace = await makeTempDir('toctou-realswap');
    const outside = await makeTempDir('toctou-secret');
    const sourcePath = path.join(workspace, 'source.png');
    const secretPath = path.join(outside, 'secret.png');
    await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));
    await fsp.writeFile(secretPath, Buffer.alloc(256, 9));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-toctou-realswap',
    });
    const fetchSpy = mockOpenAIImageResponses();

    // Simulate the F-1 race with a REAL pathname swap on disk: after the
    // fence's realpath validation but before the baseline stat, replace the
    // fence-validated regular file with a symlink to an out-of-fence target.
    // The baseline stat and the open then both follow the swap, so a stat/open
    // dev+ino agreement check passes on the secret inode; only re-resolving
    // the canonical path after the open binds the fence decision to the opened
    // inode. The mock exists purely to time the swap deterministically (the
    // baseline stat is the first post-fence access) — the symlink swap itself
    // is real.
    const realStat = fs.promises.stat.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (
      target: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (!swapped && String(target) === sourcePath) {
        swapped = true;
        await fsp.rm(sourcePath);
        await fsp.symlink(secretPath, sourcePath);
      }
      return realStat(target, ...(rest as [never]));
    }) as typeof fs.promises.stat);

    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme recolor',
          image_paths: [sourcePath],
          quality: 'medium',
        },
      })) as CallToolResult;

      const payload = extractErrorPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('WORKSPACE_FENCE_VIOLATION');
      expect(payload.error).toContain('changed while it was being verified');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await pair.close();
    }
  });

  it('rejects the swap-back: leaf flipped to a symlink for open, back for realpath, to the symlink again for the post-open lstat', async () => {
    const workspace = await makeTempDir('toctou-swapback');
    const outside = await makeTempDir('toctou-swapback-secret');
    const sourcePath = path.join(workspace, 'source.png');
    const secretPath = path.join(outside, 'secret.png');
    const backupPath = path.join(outside, 'leaf-backup.png');
    const stagedLinkPath = path.join(outside, 'staged-link');
    await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));
    await fsp.writeFile(secretPath, Buffer.alloc(256, 9));
    await fsp.symlink(secretPath, stagedLinkPath);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      OPENAI_API_KEY: 'sk-test-Acme-toctou-swapback',
    });
    const fetchSpy = mockOpenAIImageResponses();

    // Reproduce the swap-back race from the adversarial review with REAL
    // atomic renames on disk: (1) before the baseline stat, flip the
    // fence-validated leaf to a symlink→secret so the baseline stat, the open,
    // and the descriptor all agree on the secret inode; (2) once the open has
    // pinned the secret's descriptor, flip the leaf back to the regular file
    // so the post-open realpath yields the in-fence canonical path; (3) after
    // that realpath, flip to the symlink again so a path-following post-open
    // stat would observe the secret inode and pass. Only an lstat (symlink
    // exposed) or a descriptor-derived canonical path catches the flip. The
    // mocks exist purely to time the three flips deterministically; the third
    // flip is synchronous because the connector's realpath→lstat pair is
    // deliberately synchronous (no event-loop window between them).
    const swapIn = async (): Promise<void> => {
      await fsp.rename(sourcePath, backupPath);
      await fsp.rename(stagedLinkPath, sourcePath);
    };
    const swapOut = async (): Promise<void> => {
      await fsp.rename(sourcePath, stagedLinkPath);
      await fsp.rename(backupPath, sourcePath);
    };
    const swapInSync = (): void => {
      fs.renameSync(sourcePath, backupPath);
      fs.renameSync(stagedLinkPath, sourcePath);
    };

    let stage = 0;
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (
      target: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (stage === 0 && String(target) === sourcePath) {
        stage = 1;
        await swapIn();
      }
      return realStat(target, ...(rest as [never]));
    }) as typeof fs.promises.stat);

    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (
      target: fs.PathLike,
      flags?: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      const handle = await realOpen(target, flags, mode);
      if (stage === 1 && String(target) === sourcePath) {
        stage = 2;
        await swapOut();
      }
      return handle;
    }) as typeof fs.promises.open);

    realpathSyncHooks.push({
      targetPath: sourcePath,
      fire: () => {
        if (stage === 2) {
          stage = 3;
          swapInSync();
        }
      },
    });

    const pair = await createInMemoryClientPair(connector.createServer());

    try {
      const result = (await pair.client.callTool({
        name: 'edit_image',
        arguments: {
          prompt: 'Acme recolor',
          image_paths: [sourcePath],
          quality: 'medium',
        },
      })) as CallToolResult;

      expect(stage).toBe(3);
      const payload = extractErrorPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('WORKSPACE_FENCE_VIOLATION');
      expect(payload.error).toContain('changed while it was being verified');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await pair.close();
    }
  });

  // Linux-only: the directory-component swap is the documented residual on
  // platforms without /proc (lstat follows directory symlinks, so checks 1-2
  // can both pass on a swapped ancestor). On Linux the descriptor-derived
  // canonical path (/proc/self/fd) closes it — this test pins that guarantee
  // and would fail if the /proc check were ever removed.
  it.skipIf(process.platform !== 'linux')(
    'rejects a directory-component swap timed between the post-open realpath and lstat (descriptor path check)',
    async () => {
      const workspace = await makeTempDir('toctou-dirswap');
      const outside = await makeTempDir('toctou-dirswap-secret');
      const dirPath = path.join(workspace, 'd');
      const attackDir = path.join(outside, 'attdir');
      const sourcePath = path.join(dirPath, 'img.png');
      const secretPath = path.join(attackDir, 'img.png');
      const dirBackupPath = path.join(outside, 'd-backup');
      const stagedDirLinkPath = path.join(outside, 'staged-dir-link');
      await fsp.mkdir(dirPath);
      await fsp.mkdir(attackDir);
      await fsp.writeFile(sourcePath, Buffer.alloc(256, 7));
      await fsp.writeFile(secretPath, Buffer.alloc(256, 9));
      await fsp.symlink(attackDir, stagedDirLinkPath);

      const connector = await importConnectorModule({
        MCP_WORKSPACE_PATH: workspace,
        OPENAI_API_KEY: 'sk-test-Acme-toctou-dirswap',
      });
      const fetchSpy = mockOpenAIImageResponses();

      // Replace the in-workspace directory component with a symlink to an
      // out-of-fence directory holding a real entry of the same name: the
      // baseline stat and the open then land on the secret inode; with the
      // directory restored, the post-open realpath still yields the in-fence
      // canonical path; and with the symlink re-planted, the lstat follows the
      // directory component and agrees with the pinned descriptor. Only the
      // descriptor-derived canonical path (/proc/self/fd) catches this.
      const swapDirIn = async (): Promise<void> => {
        await fsp.rename(dirPath, dirBackupPath);
        await fsp.rename(stagedDirLinkPath, dirPath);
      };
      const swapDirOut = async (): Promise<void> => {
        await fsp.rename(dirPath, stagedDirLinkPath);
        await fsp.rename(dirBackupPath, dirPath);
      };
      const swapDirInSync = (): void => {
        fs.renameSync(dirPath, dirBackupPath);
        fs.renameSync(stagedDirLinkPath, dirPath);
      };

      let stage = 0;
      const realStat = fs.promises.stat.bind(fs.promises);
      vi.spyOn(fs.promises, 'stat').mockImplementation((async (
        target: fs.PathLike,
        ...rest: unknown[]
      ) => {
        if (stage === 0 && String(target) === sourcePath) {
          stage = 1;
          await swapDirIn();
        }
        return realStat(target, ...(rest as [never]));
      }) as typeof fs.promises.stat);

      const realOpen = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation((async (
        target: fs.PathLike,
        flags?: fs.OpenMode,
        mode?: fs.Mode,
      ) => {
        const handle = await realOpen(target, flags, mode);
        if (stage === 1 && String(target) === sourcePath) {
          stage = 2;
          await swapDirOut();
        }
        return handle;
      }) as typeof fs.promises.open);

      realpathSyncHooks.push({
        targetPath: sourcePath,
        fire: () => {
          if (stage === 2) {
            stage = 3;
            swapDirInSync();
          }
        },
      });

      const pair = await createInMemoryClientPair(connector.createServer());

      try {
        const result = (await pair.client.callTool({
          name: 'edit_image',
          arguments: {
            prompt: 'Acme recolor',
            image_paths: [sourcePath],
            quality: 'medium',
          },
        })) as CallToolResult;

        expect(stage).toBe(3);
        const payload = extractErrorPayload(result);
        expect(payload.ok).toBe(false);
        expect(payload.code).toBe('WORKSPACE_FENCE_VIOLATION');
        expect(payload.error).toContain('changed while it was being verified');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await pair.close();
      }
    },
  );
});
