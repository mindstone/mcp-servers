import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectorError } from '../src/types.js';

const SRC_DIR = path.resolve(import.meta.dirname, '../src');

function getAllFiles(dir: string, ext = '.ts'): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      files.push(...getAllFiles(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Security — No internal references', () => {
  const sourceFiles = getAllFiles(SRC_DIR);

  it('should not reference internal brand names in source', () => {
    const forbidden = /mindstone|rebel|nspr/i;
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (forbidden.test(lines[i])) {
          violations.push(`${path.relative(SRC_DIR, file)}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    expect(violations, `Found internal references:\n${violations.join('\n')}`).toEqual([]);
  });

  it('should not contain hardcoded secrets in source', () => {
    const secretPatterns = [
      /sk_live[_-]/i,
      /sk_test[_-]/i,
      /key_real[_-]/i,
      /xoxb-[a-zA-Z0-9]/i,
      /xoxp-[a-zA-Z0-9]/i,
    ];
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of secretPatterns) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(SRC_DIR, file)}: matches ${pattern}`);
        }
      }
    }

    expect(violations, `Found hardcoded secrets:\n${violations.join('\n')}`).toEqual([]);
  });

  it('should not contain host-specific bridge code in source', () => {
    const bridgePatterns = [
      /MINDSTONE_REBEL_BRIDGE_STATE/,
      /REBEL_WORKSPACE_PATH/,
      /\/bundled\//,
      /bridge\.ts/,
    ];
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of bridgePatterns) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(SRC_DIR, file)}: matches ${pattern}`);
        }
      }
    }

    expect(violations, `Found host-specific bridge code:\n${violations.join('\n')}`).toEqual([]);
  });

  it('ConnectorError does not leak credentials', () => {
    const error = new ConnectorError(
      'CLI command failed',
      'CLI_ERROR',
      'Check that agent-browser is installed.',
    );
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('Bearer');
    expect(error.message).toBe('CLI command failed');
    expect(error.code).toBe('CLI_ERROR');
  });
});
