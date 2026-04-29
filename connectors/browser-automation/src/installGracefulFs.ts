/**
 * Boot-time graceful-fs install (leaf module).
 *
 * The browser-automation MCP server runs as a Node child process spawned by
 * its host (e.g. via `npx`). It has its own `fs` surface and needs its own
 * `graceful-fs.gracefulify(fs)` call to mitigate EMFILE / ENFILE bursts —
 * notably on Windows where the default file descriptor / handle ceiling is
 * tight and long-running browser-automation sessions can exhaust it.
 *
 * Imported as the very first statement of `index.ts` so the patch is
 * installed before any other module touches `node:fs`.
 *
 * Kill switch: set `MCP_DISABLE_GRACEFUL_FS=1` to disable the patch.
 *
 * Failure handling: stash on `globalThis.__MCP_BOOTSTRAP_ERROR__` so future
 * observability hooks can surface it. With `MCP_DEBUG_BOOTSTRAP=1` the
 * failure also logs to stderr.
 */

import { createRequire } from 'node:module';

if (process.env.MCP_DISABLE_GRACEFUL_FS !== '1') {
  try {
    // CommonJS interop — graceful-fs is a CJS package.
    const requireFn = createRequire(import.meta.url);
    const gracefulFs = requireFn('graceful-fs') as {
      gracefulify: (fs: typeof import('node:fs')) => void;
    };
    const fs = requireFn('node:fs') as typeof import('node:fs');
    gracefulFs.gracefulify(fs); // idempotent
  } catch (e) {
    const g = globalThis as { __MCP_BOOTSTRAP_ERROR__?: unknown };
    g.__MCP_BOOTSTRAP_ERROR__ = {
      kind: 'graceful_fs_leaf_install_failed',
      error: {
        name: (e as Error)?.name,
        message: (e as Error)?.message,
        stack: (e as Error)?.stack,
      },
      at: Date.now(),
    };
    if (process.env.MCP_DEBUG_BOOTSTRAP === '1') {
      // eslint-disable-next-line no-console
      console.warn('[installGracefulFs] failed:', e);
    }
  }
}
