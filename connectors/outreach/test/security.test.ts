import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dirname, '../src');
const TEST_DIR = path.resolve(import.meta.dirname, '.');

function getAllFiles(dir: string, ext = '.ts'): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      files.push(...getAllFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      files.push(full);
    }
  }
  return files;
}

describe('Security audit — Outreach MCP server', () => {
  it('contains no internal mindstone/rebel/nspr references in source (except bridge.ts legacy env var)', () => {
    const srcFiles = getAllFiles(SRC_DIR);
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const basename = path.basename(file);

      // bridge.ts is allowed to have MINDSTONE_REBEL_BRIDGE_STATE as legacy fallback
      if (basename === 'bridge.ts') {
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.includes('MINDSTONE_REBEL_BRIDGE_STATE')) continue; // allowed legacy fallback
          expect(line.toLowerCase(), `Unexpected reference in bridge.ts: ${line.trim()}`).not.toMatch(/mindstone|rebel|nspr/);
        }
        continue;
      }

      expect(content.toLowerCase(), `Unexpected reference in ${basename}`).not.toMatch(/mindstone|rebel|nspr/);
    }
  });

  it('contains no hardcoded secrets', () => {
    const allContent = getAllFiles(SRC_DIR)
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');
    expect(allContent).not.toMatch(/sk_live|sk_test|key_real|xoxb-|xoxp-/);
  });

  it('contains no host-specific bridge endpoints', () => {
    const srcContent = getAllFiles(SRC_DIR)
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');
    expect(srcContent).not.toMatch(/\/bundled\//);
  });

  it('error messages are host-neutral (no Rebel/Mindstone in user-facing strings)', () => {
    const srcContent = getAllFiles(SRC_DIR)
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');

    const lines = srcContent.split('\n');
    for (const line of lines) {
      // Skip comments, imports, and the legacy bridge env var constant
      if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('import')) continue;
      if (line.includes('MINDSTONE_REBEL_BRIDGE_STATE')) continue;

      // Check string literals for host-specific references
      const stringMatches = line.match(/'[^']*'|"[^"]*"|`[^`]*`/g);
      if (stringMatches) {
        for (const str of stringMatches) {
          expect(str.toLowerCase()).not.toMatch(/\brebel\b/);
          expect(str.toLowerCase()).not.toMatch(/\bmindstone\b/);
        }
      }
    }
  });
});
