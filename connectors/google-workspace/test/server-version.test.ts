import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SERVER_INFO } from '../src/tools/server.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

describe('server version metadata', () => {
  it('uses package.json as the single source of truth', () => {
    expect(SERVER_INFO.version).toBe(pkg.version);
  });
});
