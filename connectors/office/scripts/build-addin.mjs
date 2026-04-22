#!/usr/bin/env node

/**
 * Build the Office Add-in browser bundle.
 *
 * Compiles src/addin/taskpane.ts (+ all imports) into a single IIFE bundle
 * at dist/addin/taskpane.js. Also copies the taskpane.html to dist/addin/.
 *
 * The Office.js library is loaded via CDN <script> tag, NOT bundled.
 * Output runs in the Office WebView browser context — no Node.js APIs.
 *
 * Uses esbuild (available from root node_modules).
 */

import esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const outDir = join(packageRoot, 'dist', 'addin');

// Ensure output directory exists
mkdirSync(outDir, { recursive: true });

// Bundle the add-in TypeScript into a single browser-compatible JS file
esbuild.buildSync({
  entryPoints: [join(packageRoot, 'src', 'addin', 'taskpane.ts')],
  bundle: true,
  outfile: join(outDir, 'taskpane.js'),
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  // Office.js globals (Office, Word, Excel, PowerPoint, OfficeExtension) are
  // loaded via CDN script tag in the HTML — they must NOT be bundled or
  // resolved. Since they're accessed as global variables (not imported),
  // esbuild leaves them alone automatically.
});

// Copy static assets to dist
cpSync(
  join(packageRoot, 'src', 'addin', 'taskpane.html'),
  join(outDir, 'taskpane.html'),
);

// Copy icon assets for the manifest
const assetsDir = join(packageRoot, 'assets');
const outAssetsDir = join(outDir, 'assets');
mkdirSync(outAssetsDir, { recursive: true });
cpSync(assetsDir, outAssetsDir, { recursive: true });

console.log('[build-addin] Built dist/addin/taskpane.js + taskpane.html + assets/');
