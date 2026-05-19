import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'test/request-manifest.json');
const before = fs.readFileSync(manifestPath, 'utf8');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-request-manifest-'));
const tempManifest = path.join(tempDir, 'request-manifest.json');

const script = path.join(root, 'scripts/generate-request-manifest.mjs');
const result = spawnSync(process.execPath, [script], {
  cwd: root,
  stdio: 'pipe',
  env: { ...process.env, ENABLE_GOOGLE_TASKS_FORMS: 'true' },
  encoding: 'utf8',
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stderr.write(result.stdout);
  process.exit(result.status ?? 1);
}

const after = fs.readFileSync(manifestPath, 'utf8');
fs.writeFileSync(tempManifest, after);
fs.writeFileSync(manifestPath, before);

if (before !== after) {
  process.stderr.write(
    `test/request-manifest.json is out of date. Run "npm run request:manifest".\nGenerated manifest was saved for inspection at ${tempManifest}\n`,
  );
  process.exit(1);
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('request-manifest.json is up to date');
