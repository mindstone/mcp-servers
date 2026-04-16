import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dirname, '..', 'src');
const TEST_DIR = path.resolve(import.meta.dirname);

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

function readAllSourceFiles(): string {
  const srcFiles = getAllFiles(SRC_DIR);
  return srcFiles.map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
}

describe('Security audit — Salesforce MCP server', () => {
  it('source contains no internal references (mindstone/rebel/nspr)', () => {
    const srcFiles = getAllFiles(SRC_DIR);
    // Exclude bridge.ts which has the standard legacy env var fallback per mcp-servers convention
    const nonBridgeFiles = srcFiles.filter((f) => !f.endsWith('bridge.ts'));
    const source = nonBridgeFiles.map((f) => fs.readFileSync(f, 'utf-8')).join('\n');

    const patterns = [/mindstone/i, /\brebel\b/i, /\bnspr\b/i];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      expect(match, `Found internal reference: ${match?.[0]}`).toBeNull();
    }

    // bridge.ts: only the standard MINDSTONE_REBEL_BRIDGE_STATE legacy fallback is allowed
    const bridgeFile = srcFiles.find((f) => f.endsWith('bridge.ts'));
    if (bridgeFile) {
      const bridgeSource = fs.readFileSync(bridgeFile, 'utf-8');
      const lines = bridgeSource.split('\n').filter((l) => !l.includes('MINDSTONE_REBEL_BRIDGE_STATE'));
      const filtered = lines.join('\n');
      for (const pattern of patterns) {
        const match = filtered.match(pattern);
        expect(match, `bridge.ts has non-standard internal reference: ${match?.[0]}`).toBeNull();
      }
    }
  });

  it('source contains no host-specific bridge code', () => {
    const source = readAllSourceFiles();
    // The bridge.ts should use generic env vars, not host-specific paths
    expect(source).not.toContain('/bundled/salesforce/');
    expect(source).not.toContain('/bundled/');
  });

  it('source contains no hardcoded secrets', () => {
    const source = readAllSourceFiles();
    const secretPatterns = [
      /sk_live[a-zA-Z0-9_]+/,
      /sk_test[a-zA-Z0-9_]+/,
      /key_real[a-zA-Z0-9_]+/,
      /xoxb-[a-zA-Z0-9-]+/,
      /xoxp-[a-zA-Z0-9-]+/,
    ];
    for (const pattern of secretPatterns) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('error messages are host-neutral', () => {
    const source = readAllSourceFiles();
    // Error strings should not reference specific host apps
    const lines = source.split('\n');
    const errorLines = lines.filter((l) =>
      l.includes('throw new') || l.includes('error:') || l.includes('resolution:'),
    );
    const errorText = errorLines.join('\n').toLowerCase();
    expect(errorText).not.toContain('rebel');
    expect(errorText).not.toContain('mindstone');
  });

  it('all tool parameters use snake_case', () => {
    const srcFiles = getAllFiles(SRC_DIR);
    const toolFiles = srcFiles.filter((f) => f.includes('/tools/'));
    const camelCaseParamPattern = /z\.object\(\{([^}]+)\}/g;

    for (const file of toolFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      let match;
      while ((match = camelCaseParamPattern.exec(content)) !== null) {
        const paramBlock = match[1];
        // Extract parameter names (keys before the colon in z.object)
        const paramNames = paramBlock.match(/(\w+)\s*:/g);
        if (paramNames) {
          for (const param of paramNames) {
            const name = param.replace(':', '').trim();
            // All param names should be snake_case or single-word lowercase
            expect(
              /^[a-z][a-z0-9_]*$/.test(name),
              `Parameter "${name}" in ${path.basename(file)} should be snake_case`,
            ).toBe(true);
          }
        }
      }
    }
  });
});
