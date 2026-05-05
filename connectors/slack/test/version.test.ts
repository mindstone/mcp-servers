import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { SERVER_VERSION, SERVER_NAME } from '../src/types.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string; name: string };

describe('SERVER_VERSION', () => {
  it('matches package.json version (no drift)', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('SERVER_NAME is stable', () => {
    expect(SERVER_NAME).toBe('slack-mcp-server');
  });
});
