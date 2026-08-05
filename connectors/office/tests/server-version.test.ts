/**
 * The McpServer instance must report the real package version — a hardcoded
 * literal drifted a full release behind package.json once already.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverModule = (await import('../src/index.js')) as unknown as {
  __test: { packageVersion: string };
};

describe('server version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
        'utf8',
      ),
    ) as { version: string };

    expect(serverModule.__test.packageVersion).toBe(pkg.version);
    expect(serverModule.__test.packageVersion).not.toBe('unknown');
  });
});
