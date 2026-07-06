import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// REBEL-\d+ / FOX-\d+ catch internal issue-tracker references (public repo:
// ticket IDs must not ship in source or generated HTML). Mirrors the pattern in
// scripts/check-internal-refs.mjs.
const pattern = /@nspr|REBEL_HOST_CONTEXT|rebel\.local|MINDSTONE_REBEL_BRIDGE_STATE|MCP_HOST_BRIDGE_STATE|REBEL_WORKSPACE_PATH|loadBridgeState|bridgeRequest|\/bundled\/|\.rebel-icon|REBEL-\d+|FOX-\d+/;

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

describe('internal reference strip', () => {
  it('has no blocked internal references in src', () => {
    const matches = collectFiles(path.join(root, 'src')).filter((file) =>
      pattern.test(fs.readFileSync(file, 'utf8')),
    );
    expect(matches).toEqual([]);
  });
});
