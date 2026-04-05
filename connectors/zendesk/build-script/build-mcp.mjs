#!/usr/bin/env node

/**
 * Standalone build script for a single MCP connector.
 *
 * Adapted from the MindstoneRebel monorepo's build-bundled-mcps.js.
 * Compiles TypeScript, bundles with esbuild into a single CJS file,
 * and generates a manifest.json with build metadata.
 *
 * Usage: node build-script/build-mcp.mjs
 * Or via npm: npm run bundle
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const connectorRoot = resolve(__dirname, '..');

const mcpConfig = JSON.parse(readFileSync(join(__dirname, 'mcp-config.json'), 'utf8'));
const mcpName = mcpConfig.mcpName;

const entryPoint = join(connectorRoot, 'build', 'index.js');
const distDir = join(connectorRoot, 'dist');
const outfile = join(distDir, 'server.cjs');

// ── Step 1: Compile TypeScript ──────────────────────────────────────────────

console.log(`🔨 Compiling TypeScript for ${mcpName}...`);
try {
  execSync('npx tsc', { cwd: connectorRoot, stdio: 'inherit' });
  console.log('✅ TypeScript compilation succeeded.');
} catch {
  console.error('❌ TypeScript compilation failed.');
  process.exit(1);
}

if (!existsSync(entryPoint)) {
  console.error(`❌ Entry point not found after compilation: ${entryPoint}`);
  console.error('   Check that tsconfig.json outDir matches expected build/index.js.');
  process.exit(1);
}

// ── Step 2: Bundle with esbuild ─────────────────────────────────────────────

console.log(`📦 Bundling ${mcpName} with esbuild → server.cjs...`);

mkdirSync(distDir, { recursive: true });

try {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    sourcemap: false,
    minify: true,
    logLevel: 'warning',
  });

  const bundleSize = statSync(outfile).size;
  const sizeKB = (bundleSize / 1024).toFixed(1);
  console.log(`✅ Bundled to server.cjs (${sizeKB} KB)`);
} catch (err) {
  console.error(`❌ esbuild bundling failed: ${err.message}`);
  process.exit(1);
}

// ── Step 3: Generate manifest.json ──────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(connectorRoot, 'package.json'), 'utf8'));

let gitCommit = 'dev';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {
  // Not in a git repo yet or git not available
}

const manifest = {
  connectorId: mcpName,
  connectorVersion: pkg.version,
  gitCommit,
  builtAgainstRebelBridge: '1.0',
  toolNamespace: 'Zendesk',
  builtAt: new Date().toISOString(),
};

const manifestPath = join(distDir, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('✅ Generated manifest.json');

// ── Step 4: Syntax check ────────────────────────────────────────────────────

console.log('🔍 Running syntax check on bundle...');
try {
  execSync(`node --check "${outfile}"`, { stdio: 'pipe', timeout: 5000 });
  console.log('✅ Syntax check passed.');
} catch {
  console.error('❌ Bundle failed syntax check — output may be corrupt.');
  process.exit(1);
}

console.log(`\n🎉 Build complete for ${mcpName}!`);
console.log(`   Bundle: dist/server.cjs (${(statSync(outfile).size / 1024).toFixed(1)} KB)`);
console.log(`   Manifest: dist/manifest.json`);
