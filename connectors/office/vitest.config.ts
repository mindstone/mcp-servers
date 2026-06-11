import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // globalSetup runs once in the parent process before any worker spawns —
    // this is where the synthetic TLS fixture is generated, serializing what
    // used to be a per-worker race. setupFiles (per worker) only installs the
    // office-addin-dev-certs mock that reads that fixture.
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
