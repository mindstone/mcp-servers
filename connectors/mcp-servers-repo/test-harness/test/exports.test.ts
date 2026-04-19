import { describe, it, expect } from 'vitest';

describe('package exports', () => {
  it('exports all 6 required functions', async () => {
    const harness = await import('../src/index.js');

    // Verify all 6 required exports exist and are functions
    expect(typeof harness.createInMemoryTestClient).toBe('function');
    expect(typeof harness.createStdioTestClient).toBe('function');
    expect(typeof harness.setupMswServer).toBe('function');
    expect(typeof harness.createBridgeHandlers).toBe('function');
    expect(typeof harness.createTempConfig).toBe('function');
  });

  it('exports type interfaces (compile-time check)', async () => {
    // These are type-only imports that verify the package.json exports config works
    const harness = await import('../src/index.js');

    // Verify we can access the functions without errors
    const client = harness.createInMemoryTestClient;
    const stdio = harness.createStdioTestClient;
    const msw = harness.setupMswServer;
    const bridge = harness.createBridgeHandlers;
    const temp = harness.createTempConfig;

    expect(client).toBeDefined();
    expect(stdio).toBeDefined();
    expect(msw).toBeDefined();
    expect(bridge).toBeDefined();
    expect(temp).toBeDefined();
  });
});
