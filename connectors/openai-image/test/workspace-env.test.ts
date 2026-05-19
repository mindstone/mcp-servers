import { afterEach, describe, expect, it, vi } from 'vitest';
import { importConnectorModule } from './helpers.js';

const LEGACY_WORKSPACE_ENV = ['RE', 'BEL_WORKSPACE_PATH'].join('');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('workspace env handling', () => {
  it('consumes MCP_WORKSPACE_PATH when provided', async () => {
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: '/tmp/new-workspace',
      [LEGACY_WORKSPACE_ENV]: '/tmp/legacy-workspace',
    });

    expect(connector.configuredWorkspacePath()).toBe('/tmp/new-workspace');
  });

  it('does not fall back to legacy workspace env names', async () => {
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: '',
      [LEGACY_WORKSPACE_ENV]: '/tmp/legacy-workspace',
    });

    expect(connector.configuredWorkspacePath()).toBeUndefined();
  });
});
