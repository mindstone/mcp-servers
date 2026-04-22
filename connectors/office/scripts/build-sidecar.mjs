#!/usr/bin/env node

/**
 * Build the Office sidecar as a single self-contained Node.js bundle.
 *
 * All imports of the vendored App Bridge core primitives
 * (`src/shared/appBridge/*`) and the shared sidecar contracts
 * (`src/shared/sidecar/*`) resolve via ordinary relative paths — no tsconfig
 * path aliases are involved. esbuild walks the graph and inlines everything
 * into `dist/sidecar/cli.js`.
 *
 * Runtime externals:
 *   - `ws` — TCP WebSocket library; shipped as a runtime dependency of this
 *     package, resolved by npm at install time.
 *   - `office-addin-dev-certs` — HTTPS cert helper; same.
 *   - Node.js built-ins (node:fs, node:path, etc.) — always external.
 *
 * Output: `dist/sidecar/cli.js` (ESM). The stdio MCP entry (`dist/index.js`)
 * spawns this with `node dist/sidecar/cli.js` as a lazy-start fallback; host
 * applications are expected to manage the sidecar lifecycle directly.
 */

import esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const outDir = join(packageRoot, 'dist', 'sidecar');

await esbuild.build({
  entryPoints: [join(packageRoot, 'src', 'sidecar', 'cli.ts')],
  bundle: true,
  outfile: join(outDir, 'cli.js'),
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // The package declares these as runtime dependencies (see package.json);
  // do not bundle them.
  external: ['ws', 'office-addin-dev-certs'],
  sourcemap: true,
});

console.error('[build-sidecar] Built dist/sidecar/cli.js');
