import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// REBEL-\d+ / FOX-\d+ catch internal issue-tracker references: this is a
// public, source-available repo, so ticket IDs must never ship in source or in
// the generated compose-app HTML (see AGENTS.md). A pair of these leaked in via
// the shared @mindstone/mcp-app-compose builder and were scrubbed 2026-07.
const pattern = /@nspr|REBEL_HOST_CONTEXT|rebel\.local|MINDSTONE_REBEL_BRIDGE_STATE|MCP_HOST_BRIDGE_STATE|REBEL_WORKSPACE_PATH|loadBridgeState|bridgeRequest|\/bundled\/|\.rebel-icon|REBEL-\d+|FOX-\d+/;
const roots = ['src', 'dist'];
const matches = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (pattern.test(text)) {
      matches.push(path.relative(root, full));
    }
  }
}

for (const dir of roots) {
  walk(path.join(root, dir));
}

if (matches.length > 0) {
  console.error(`Internal reference check failed:\n${matches.join('\n')}`);
  process.exit(1);
}

console.log('Internal reference check passed');
